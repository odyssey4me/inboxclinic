// SPDX-License-Identifier: Apache-2.0
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
 * 3. **OR-combine ≤10 domains** per filter (`*@a.com OR *@b.com …`), chunked at
 *    content-defined boundaries so one domain's add/remove doesn't reshuffle the rest (#152).
 * 4. **Soft cap ~450** filters (headroom below Gmail's 500) — stop creating beyond it
 *    and surface a flag; domain aggregation is preferred so the cap covers more senders.
 */

import type { Sender } from "../store/types";
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
/**
 * Character budget for one filter's criteria (`from` + `negatedQuery`). Gmail's practical
 * limit is ~1500 characters; a filter over it is rejected outright, so the compiler keeps the
 * exception carve-out inside the budget rather than emitting a rule that can never be created
 * (design-gmail-integration.md Decision 5, exception-overflow handling; #182/#191).
 */
export const DEFAULT_MAX_CRITERIA_CHARS = 1500;

export interface CompileFiltersOptions {
  domainBlockThreshold?: number;
  maxDomainsPerFilter?: number;
  softCap?: number;
  /** Character budget for one filter's criteria (`from` + `negatedQuery`). */
  maxCriteriaChars?: number;
}

/**
 * How a domain block whose exception carve-out overflowed the criteria budget was compiled
 * instead (#191). Both forms lose the "covers senders not seen yet" guarantee for that domain,
 * so the caller surfaces the caveat rather than the user discovering it from behaviour.
 */
export interface ExceptionOverflow {
  domain: string;
  /**
   * `enumerate` — one `from:<address>` filter per still-blocked observed sender, replacing the
   * single `*@domain` + `negatedQuery`. `dropped` — no filter at all, because no observed
   * member list was supplied to enumerate from; the domain is NOT blocked and the caller must
   * say so.
   */
  strategy: "enumerate" | "dropped";
  /** How many exception addresses the carve-out carried when it overflowed. */
  exceptionCount: number;
}

export interface CompiledFilters {
  /** The desired native-filter set (capped at `softCap`). */
  filters: FilterSpec[];
  /** True when the desired set exceeded the soft cap and was truncated. */
  capReached: boolean;
  /** How many would-be filters were dropped because the cap was reached. */
  skippedAtCap: number;
  /** Domain blocks whose exception list overflowed one filter's criteria budget (#191). */
  exceptionOverflows: ExceptionOverflow[];
}

/** A blocked domain plus the exception addresses to carve out of its `*@domain` block. */
export interface BlockedDomainInput {
  domain: string;
  excludeAddresses?: string[];
  /**
   * The domain's observed senders whose effective status is still blocked. Only read when the
   * exception carve-out overflows the criteria budget, to compile the enumerate form (#191).
   * Omit it and an overflowing domain compiles to no filter at all rather than to a filter
   * Gmail would reject.
   */
  blockedMemberAddresses?: string[];
}

/**
 * Deterministic 32-bit FNV-1a hash of a string. Pure and stable across runs (no RNG) — used
 * only to place a content-defined chunk boundary, never for anything security-sensitive.
 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Group sorted domains into OR-combine chunks with CONTENT-DEFINED boundaries: a chunk closes
 * after a domain whose hash marks a boundary (≈1 in `maxPerFilter` domains), or when it reaches
 * `maxPerFilter` (the hard OR-combine cap). Because boundaries are anchored to a domain's own
 * hash — not its position in the global sorted list — adding or removing one domain only
 * re-chunks locally; unrelated domains keep the same chunk, and therefore the same filter
 * signature, so reconcile stops deleting+recreating filters that didn't semantically change (#152).
 *
 * The locality is PROBABILISTIC, as with any content-defined chunker: a change re-syncs at the
 * next domain whose hash is a marker, so the disturbed region spans the run up to that marker
 * (~1 chunk in expectation, but a marker-free run re-splits by count until the next marker).
 *
 * Packing vs. churn is a deliberate trade: setting the marker rate equal to the cap
 * (`% maxPerFilter`) truncates the geometric run length hard, so expected chunk size is only
 * ~2/3 of the cap (E ≈ 6.5 domains per 10-domain filter), not near-full. A rarer marker would
 * pack tighter but widen the re-chunk region — the wrong trade for #152, and the ~450 soft cap
 * has ample headroom for the extra filters. Degenerate `maxPerFilter <= 1`, or a domain set that
 * all hashes to markers, degrades to one domain per filter (worst packing, still correct).
 */
function chunkDomainsStably(sortedDomains: readonly string[], maxPerFilter: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const domain of sortedDomains) {
    current.push(domain);
    const atMarker = hash32(domain) % maxPerFilter === 0;
    if (current.length >= maxPerFilter || atMarker) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function blockFilter(from: string, excludeFrom?: string): FilterSpec {
  return {
    from,
    ...(excludeFrom !== undefined && excludeFrom !== "" ? { excludeFrom } : {}),
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
  blockedDomains: ReadonlyArray<BlockedDomainInput>,
  options: CompileFiltersOptions = {},
): CompiledFilters {
  const threshold = options.domainBlockThreshold ?? DEFAULT_DOMAIN_BLOCK_THRESHOLD;
  const maxPerFilter = options.maxDomainsPerFilter ?? DEFAULT_MAX_DOMAINS_PER_FILTER;
  const softCap = options.softCap ?? DEFAULT_FILTER_SOFT_CAP;
  const maxCriteriaChars = options.maxCriteriaChars ?? DEFAULT_MAX_CRITERIA_CHARS;

  // Group address-blocked senders by domain (deduplicated, lowercased).
  const sendersByDomain = new Map<string, Set<string>>();
  for (const sender of blockedSenders) {
    const domain = sender.domain.toLowerCase();
    const set = sendersByDomain.get(domain) ?? new Set<string>();
    set.add(sender.email.toLowerCase());
    sendersByDomain.set(domain, set);
  }

  // Explicit domain blocks carrying trusted-exception carve-outs (only explicit blocks have
  // exceptions; a domain aggregated from 3+ blocked senders has no domain decision). Each maps
  // to one `negatedQuery` exclusion — sorted for a stable filter signature.
  // A carve-out that doesn't fit one filter's criteria budget degrades that domain to the
  // enumerate form instead: Gmail rejects an over-long filter outright, and the rejection is
  // indistinguishable from a transient failure, so the same doomed rule would be retried on
  // every sync while the domain stayed unblocked (#191).
  const excludeByDomain = new Map<string, string>();
  const enumeratedDomains = new Map<string, string[]>();
  const exceptionOverflows: ExceptionOverflow[] = [];
  for (const bd of blockedDomains) {
    const domain = bd.domain.toLowerCase();
    const addresses = (bd.excludeAddresses ?? [])
      .map((a) => a.toLowerCase())
      .filter((a) => a.length > 0)
      .sort();
    if (addresses.length === 0) continue;
    const negatedQuery = addresses.join(" OR ");
    if (`*@${domain}`.length + negatedQuery.length <= maxCriteriaChars) {
      excludeByDomain.set(domain, negatedQuery);
      continue;
    }
    // Over budget: one `from:<address>` filter per still-blocked observed sender, and no
    // `*@domain` filter (which would re-block the very addresses being excepted). Precise, but
    // it only covers senders seen so far — the caller surfaces that caveat.
    const members = [
      ...(bd.blockedMemberAddresses ?? []).map((a) => a.toLowerCase()).filter((a) => a.length > 0),
      // Senders of this domain blocked at address scope are covered by the domain filter that
      // is no longer being emitted, so they must be enumerated too.
      ...(sendersByDomain.get(domain) ?? []),
    ];
    const stillBlocked = [...new Set(members)].filter((a) => !addresses.includes(a)).sort();
    if (stillBlocked.length > 0) enumeratedDomains.set(domain, stillBlocked);
    exceptionOverflows.push({
      domain,
      strategy: stillBlocked.length > 0 ? "enumerate" : "dropped",
      exceptionCount: addresses.length,
    });
  }

  // Domains that warrant a domain-level filter: explicitly blocked, or 3+ blocked.
  const aggregatedDomains = new Set<string>();
  for (const bd of blockedDomains) aggregatedDomains.add(bd.domain.toLowerCase());
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

  // Domain-level filters: plain domains OR-combine up to `maxPerFilter`; a domain with a
  // trusted-exception carve-out gets its OWN filter (an OR-group can't share one exclusion).
  // An overflowed domain gets NO domain filter — a plain `*@domain` would trash exactly the
  // addresses its carve-out was protecting.
  const overflowed = new Set(exceptionOverflows.map((o) => o.domain));
  const plainDomains = [...aggregatedDomains]
    .filter((d) => !excludeByDomain.has(d) && !overflowed.has(d))
    .sort();
  const domainFilters: FilterSpec[] = [];
  for (const group of chunkDomainsStably(plainDomains, maxPerFilter)) {
    domainFilters.push(blockFilter(group.map((d) => `*@${d}`).join(" OR ")));
  }
  for (const domain of [...excludeByDomain.keys()].sort()) {
    domainFilters.push(blockFilter(`*@${domain}`, excludeByDomain.get(domain)));
  }
  for (const domain of [...enumeratedDomains.keys()].sort()) {
    for (const email of enumeratedDomains.get(domain) ?? []) domainFilters.push(blockFilter(email));
  }

  // Prefer domain aggregation (more coverage per filter) when the cap bites.
  const desired = [...domainFilters, ...senderFilters];
  if (desired.length <= softCap) {
    return { filters: desired, capReached: false, skippedAtCap: 0, exceptionOverflows };
  }
  return {
    filters: desired.slice(0, softCap),
    capReached: true,
    skippedAtCap: desired.length - softCap,
    exceptionOverflows,
  };
}

export interface FilterReconcilePlan {
  toCreate: FilterSpec[];
  toDelete: string[];
  /**
   * Untracked existing filters whose criteria + action already match a desired
   * filter. Neither created (that would duplicate it) nor deleted or auto-adopted
   * (ownership is never inferred from shape, #29) — surfaced for confirm-first
   * adoption (`suggestFilterAdoptions`, #80).
   */
  adoptable: NativeFilter[];
}

/** A stable signature over a filter's criteria + action, for set comparison. */
function signature(filter: FilterSpec): string {
  return [
    filter.from.toLowerCase(),
    (filter.excludeFrom ?? "").toLowerCase(),
    [...filter.addLabelIds].sort().join(","),
    [...filter.removeLabelIds].sort().join(","),
  ].join("|");
}

/**
 * Diff the desired filter set against the account's existing filters. Idempotent:
 * re-running after the plan is applied yields empty `toCreate`/`toDelete`. Only
 * filters whose id is in `managedFilterIds` are ever eligible for deletion — action
 * shape alone ("Trash + skip-inbox") is not proof of provenance, since that is also a
 * common hand-built Gmail filter action; foreign filters are never touched even if
 * their shape happens to match (#29). A desired filter that coincidentally matches an
 * *untracked* existing filter's criteria + action is not created either — that would
 * duplicate it — but it is also not auto-adopted; it is surfaced in `adoptable` so the
 * app can offer confirm-first adoption instead of silently guessing ownership in
 * either direction (#80).
 */
export function reconcileFilters(
  desired: ReadonlyArray<FilterSpec>,
  existing: ReadonlyArray<NativeFilter>,
  managedFilterIds: ReadonlySet<string>,
): FilterReconcilePlan {
  const desiredBySig = new Map<string, FilterSpec>();
  for (const spec of desired) desiredBySig.set(signature(spec), spec);

  const managed = existing.filter((f) => managedFilterIds.has(f.id));
  const managedSigs = new Set(managed.map(signature));

  const unmanagedBySig = new Map<string, NativeFilter>();
  for (const f of existing) {
    if (managedFilterIds.has(f.id)) continue;
    const sig = signature(f);
    if (!unmanagedBySig.has(sig)) unmanagedBySig.set(sig, f);
  }

  const toCreate: FilterSpec[] = [];
  const adoptable: NativeFilter[] = [];
  for (const [sig, spec] of desiredBySig) {
    if (managedSigs.has(sig)) continue;
    const match = unmanagedBySig.get(sig);
    if (match !== undefined) adoptable.push(match);
    else toCreate.push(spec);
  }
  const toDelete = managed.filter((f) => !desiredBySig.has(signature(f))).map((f) => f.id);

  return { toCreate, toDelete, adoptable };
}
