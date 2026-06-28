/**
 * Native-filter compilation and reconciliation — pure (no I/O).
 *
 * See docs/design-gmail-integration.md Decision 5 (native filter compilation as the
 * enforcement layer) and design-trust-decisions.md (filter OR-combine / soft cap
 * constants). Block decisions compile into native Gmail filters so Google enforces
 * them continuously, even while the app is closed. The reconcile step is **idempotent**:
 * comparing the desired set against the account's existing managed filters yields no
 * operations once they already match.
 *
 * Mapping (design §"Decision 5"):
 * 1. Sender block → `from:<address>` → Trash / skip-inbox.
 * 2. When **3+ senders of one domain** are blocked, prefer a single `from:*@domain`.
 * 3. **OR-combine ≤10 domains** per filter (`*@a.com OR *@b.com …`).
 * 4. **Soft cap ~450** filters (headroom below Gmail's 500) — stop creating beyond it
 *    and surface a flag; domain aggregation is preferred so the cap covers more senders.
 */

import type { Domain, Sender } from "../store/types";
import type { FilterSpec, NativeFilter } from "../ports/GmailClient";

/** A blocked filter sends matching mail to Trash and skips the inbox. */
export const BLOCK_FILTER_ADD_LABEL_IDS = ["TRASH"] as const;
export const BLOCK_FILTER_REMOVE_LABEL_IDS = ["INBOX"] as const;

/** Senders-per-domain before a domain-level filter is preferred (design default). */
export const DEFAULT_DOMAIN_BLOCK_THRESHOLD = 3;
/** OR-combine ceiling per filter (design default). */
export const DEFAULT_MAX_DOMAINS_PER_FILTER = 10;
/** Stop creating filters near Gmail's 500 limit (design default). */
export const DEFAULT_FILTER_SOFT_CAP = 450;

export interface CompileFiltersOptions {
  domainBlockThreshold?: number;
  maxDomainsPerFilter?: number;
  softCap?: number;
}

export interface CompiledFilters {
  /** The desired native-filter set (capped at `softCap`). */
  filters: FilterSpec[];
  /** True when the desired set exceeded the soft cap and was truncated. */
  capReached: boolean;
  /** How many would-be filters were dropped because the cap was reached. */
  skippedAtCap: number;
}

function blockFilter(from: string): FilterSpec {
  return {
    from,
    addLabelIds: [...BLOCK_FILTER_ADD_LABEL_IDS],
    removeLabelIds: [...BLOCK_FILTER_REMOVE_LABEL_IDS],
  };
}

/**
 * Compile the standing set of blocked senders/domains into desired native filters.
 *
 * `blockedSenders` are address-scope blocks; `blockedDomains` are domain-scope blocks.
 * A domain gets one `*@domain` filter when it is explicitly blocked **or** when at
 * least `domainBlockThreshold` of its senders are blocked; those senders are then
 * covered by the domain filter and get no individual filter.
 */
export function compileFilters(
  blockedSenders: ReadonlyArray<Pick<Sender, "email" | "domain">>,
  blockedDomains: ReadonlyArray<Pick<Domain, "domain">>,
  options: CompileFiltersOptions = {},
): CompiledFilters {
  const threshold = options.domainBlockThreshold ?? DEFAULT_DOMAIN_BLOCK_THRESHOLD;
  const maxPerFilter = options.maxDomainsPerFilter ?? DEFAULT_MAX_DOMAINS_PER_FILTER;
  const softCap = options.softCap ?? DEFAULT_FILTER_SOFT_CAP;

  // Group address-blocked senders by domain (deduplicated, lowercased).
  const sendersByDomain = new Map<string, Set<string>>();
  for (const sender of blockedSenders) {
    const domain = sender.domain.toLowerCase();
    const set = sendersByDomain.get(domain) ?? new Set<string>();
    set.add(sender.email.toLowerCase());
    sendersByDomain.set(domain, set);
  }

  // Domains that warrant a domain-level filter: explicitly blocked, or 3+ blocked.
  const aggregatedDomains = new Set<string>();
  for (const domain of blockedDomains) aggregatedDomains.add(domain.domain.toLowerCase());
  for (const [domain, emails] of sendersByDomain) {
    if (emails.size >= threshold) aggregatedDomains.add(domain);
  }

  // Sender-level filters: only for senders whose domain is not aggregated.
  const senderFilters: FilterSpec[] = [];
  for (const [domain, emails] of sendersByDomain) {
    if (aggregatedDomains.has(domain)) continue;
    for (const email of emails) senderFilters.push(blockFilter(email));
  }
  senderFilters.sort((a, b) => a.from.localeCompare(b.from));

  // Domain-level filters: OR-combine up to `maxPerFilter` domains per filter.
  const domains = [...aggregatedDomains].sort();
  const domainFilters: FilterSpec[] = [];
  for (let i = 0; i < domains.length; i += maxPerFilter) {
    const group = domains.slice(i, i + maxPerFilter);
    domainFilters.push(blockFilter(group.map((d) => `*@${d}`).join(" OR ")));
  }

  // Prefer domain aggregation (more coverage per filter) when the cap bites.
  const desired = [...domainFilters, ...senderFilters];
  if (desired.length <= softCap) {
    return { filters: desired, capReached: false, skippedAtCap: 0 };
  }
  return {
    filters: desired.slice(0, softCap),
    capReached: true,
    skippedAtCap: desired.length - softCap,
  };
}

export interface FilterReconcilePlan {
  toCreate: FilterSpec[];
  toDelete: string[];
}

/** A stable signature over a filter's criteria + action, for set comparison. */
function signature(filter: FilterSpec): string {
  return [
    filter.from.toLowerCase(),
    [...filter.addLabelIds].sort().join(","),
    [...filter.removeLabelIds].sort().join(","),
  ].join("|");
}

/** A filter is "ours" only if its action matches the block action (Trash + skip-inbox). */
function isManaged(filter: NativeFilter): boolean {
  return (
    filter.addLabelIds.includes(BLOCK_FILTER_ADD_LABEL_IDS[0]) &&
    filter.removeLabelIds.includes(BLOCK_FILTER_REMOVE_LABEL_IDS[0])
  );
}

/**
 * Diff the desired filter set against the account's existing filters. Idempotent:
 * re-running after the plan is applied yields empty `toCreate`/`toDelete`. Only
 * **managed** filters (matching the block action) are ever deleted — foreign filters
 * the user created by hand are never touched (design open question, conservative
 * default).
 */
export function reconcileFilters(
  desired: ReadonlyArray<FilterSpec>,
  existing: ReadonlyArray<NativeFilter>,
): FilterReconcilePlan {
  const desiredBySig = new Map<string, FilterSpec>();
  for (const spec of desired) desiredBySig.set(signature(spec), spec);

  const managed = existing.filter(isManaged);
  const existingSigs = new Set(managed.map(signature));

  const toCreate: FilterSpec[] = [];
  for (const [sig, spec] of desiredBySig) {
    if (!existingSigs.has(sig)) toCreate.push(spec);
  }
  const toDelete = managed.filter((f) => !desiredBySig.has(signature(f))).map((f) => f.id);

  return { toCreate, toDelete };
}
