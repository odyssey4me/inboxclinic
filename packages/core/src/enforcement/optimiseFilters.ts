// SPDX-License-Identifier: Apache-2.0
/**
 * Suggest optimisations to the account's existing native filters — design-gmail-integration.md
 * Decision 9. Read-only analysis that proposes: **consolidate** many same-domain address
 * filters into one `*@domain` rule, drop **duplicate** rules, and remove **redundant** address
 * rules already covered by a domain rule. Suggestions are confirm-first; `applyFilterOptimisations`
 * commits an accepted set through the normal create/delete filter paths and keeps
 * `filterSyncState.managedFilterIds` in step with what it created and removed (#202).
 *
 * Consolidation uses the same `DEFAULT_DOMAIN_BLOCK_THRESHOLD` that `compileFilters` uses to
 * prefer a `*@domain` rule, so an accepted consolidation is what the next `enforce()` would
 * compile from the standing decisions anyway — the tidy-up survives the next sync rather than
 * being undone by it. Passing a `consolidateThreshold` *below* the compile-side
 * `domainBlockThreshold` would break that alignment and churn the filters back.
 *
 * **Ownership gate (#29/#190).** Only filters whose id is tracked in
 * `filterSyncState.managedFilterIds` are ever offered for deletion — the same rule
 * `reconcileFilters` applies. A "Trash + skip-inbox" action shape is also what a
 * hand-built Gmail filter looks like, so shape alone is not proof of provenance; an
 * untracked filter is left alone even when it is a textbook duplicate. Untracked
 * filters still *count* as coverage (a hand-built `*@domain` rule genuinely does make
 * an address rule redundant) — they are simply never the thing removed.
 */

import {
  BLOCK_FILTER_ADD_LABEL_IDS,
  BLOCK_FILTER_REMOVE_LABEL_IDS,
  DEFAULT_DOMAIN_BLOCK_THRESHOLD,
} from "./compileFilters";
import { FILTER_SYNC_KEY } from "./enforce";
import { carriesUnmodelledCriteria, isBlockFilter, parseFilterSubjects } from "./filterShape";
import type { FilterSpec, GmailClient, NativeFilter } from "../ports/GmailClient";
import type { Store } from "../store";

export type OptimisationKind = "consolidate" | "duplicate" | "redundant";

export interface FilterOptimisation {
  kind: OptimisationKind;
  /** Human-readable summary of the change. */
  description: string;
  /** Existing filter ids to delete. */
  removeFilterIds: string[];
  /** A replacement filter to create (consolidation only). */
  createFilter?: FilterSpec;
}

export interface OptimiseFiltersOptions {
  /** Same-domain address filters at/above this count consolidate into `*@domain` (default 3). */
  consolidateThreshold?: number;
}

/** Stable key for duplicate detection: normalised criteria (incl. exclusion) + label edits. */
function filterKey(f: NativeFilter): string {
  const norm = (xs: string[]): string => [...xs].sort().join(",");
  const exclude = (f.excludeFrom ?? "").trim().toLowerCase();
  return `${f.from.trim().toLowerCase()}|${exclude}|${norm(f.addLabelIds)}|${norm(f.removeLabelIds)}`;
}

/** The lowercased addresses a filter's `excludeFrom` (`a OR b`) carves out. */
function excludeSet(excludeFrom: string | undefined): Set<string> {
  if (excludeFrom === undefined || excludeFrom === "") return new Set();
  // Literal " or " split (avoids a ReDoS-shaped `\s+or\s+` regex on Gmail-returned data).
  return new Set(
    excludeFrom
      .toLowerCase()
      .split(" or ")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function domainBlockFilter(domain: string): FilterSpec {
  return {
    from: `*@${domain}`,
    addLabelIds: [...BLOCK_FILTER_ADD_LABEL_IDS],
    removeLabelIds: [...BLOCK_FILTER_REMOVE_LABEL_IDS],
  };
}

/** Analyse existing block-shaped filters and propose optimisations (no mutation). */
export async function suggestFilterOptimisations(
  client: GmailClient,
  store: Store,
  options: OptimiseFiltersOptions = {},
): Promise<FilterOptimisation[]> {
  const threshold = options.consolidateThreshold ?? DEFAULT_DOMAIN_BLOCK_THRESHOLD;
  // Filters matching on criteria we don't model are dropped outright — not offered for
  // removal, and not counted as coverage either. A rule like `*@shop.com AND subject:sale`
  // does NOT make an address rule redundant, and two rules alike in `from` alone are not
  // duplicates of each other (#212). Judging what we cannot see is the error, in both
  // directions.
  const filters = (await client.listFilters())
    .filter(isBlockFilter)
    .filter((f) => !carriesUnmodelledCriteria(f));

  const filterSync = await store.filterSync.get();
  const managedFilterIds = new Set(filterSync?.managedFilterIds ?? []);
  const isManaged = (id: string): boolean => managedFilterIds.has(id);

  const suggestions: FilterOptimisation[] = [];

  // Duplicates: identical criteria + labels; keep one, remove the rest. The survivor is a
  // managed filter where one exists, so the app keeps tracking the rule it leaves behind;
  // only the *other managed* copies are removable, so a hand-built duplicate always stays.
  const byKey = new Map<string, string[]>();
  for (const f of filters) {
    const ids = byKey.get(filterKey(f)) ?? [];
    ids.push(f.id);
    byKey.set(filterKey(f), ids);
  }
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    const keep = ids.find(isManaged) ?? ids[0];
    const removeFilterIds = ids.filter((id) => id !== keep && isManaged(id));
    if (removeFilterIds.length === 0) continue;
    suggestions.push({
      kind: "duplicate",
      description: `${ids.length} identical filters — remove ${removeFilterIds.length} duplicate${removeFilterIds.length === 1 ? "" : "s"}`,
      removeFilterIds,
    });
  }

  // Classify single-subject filters into domain rules and address rules. A domain rule carries
  // the addresses it excludes (#145), so a carved-out address isn't treated as "covered".
  const domainRuleFor = new Map<string, { id: string; exclude: Set<string> }>();
  const addressRules: { id: string; email: string; domain: string }[] = [];
  for (const f of filters) {
    const subjects = parseFilterSubjects(f.from);
    for (const s of subjects) {
      if (s.scope === "domain")
        domainRuleFor.set(s.value, { id: f.id, exclude: excludeSet(f.excludeFrom) });
    }
    if (subjects.length === 1 && subjects[0]?.scope === "address") {
      const email = subjects[0].value;
      addressRules.push({ id: f.id, email, domain: email.slice(email.indexOf("@") + 1) });
    }
  }

  // Redundant: an address rule already covered by a domain rule — but NOT if that domain rule
  // excludes the address (then the address rule is doing real work).
  for (const rule of addressRules) {
    if (!isManaged(rule.id)) continue;
    const domainRule = domainRuleFor.get(rule.domain);
    if (domainRule !== undefined && !domainRule.exclude.has(rule.email.toLowerCase())) {
      suggestions.push({
        kind: "redundant",
        description: `${rule.email} is already covered by the *@${rule.domain} filter`,
        removeFilterIds: [rule.id],
      });
    }
  }

  // Consolidate: domains with ≥threshold uncovered *managed* address rules → one `*@domain`
  // rule. Untracked rules neither count towards the threshold nor get replaced, so a pile of
  // hand-built address filters is never traded for one broad rule the user didn't ask for.
  const uncoveredByDomain = new Map<string, { id: string; email: string }[]>();
  for (const rule of addressRules) {
    if (domainRuleFor.has(rule.domain) || !isManaged(rule.id)) continue;
    const arr = uncoveredByDomain.get(rule.domain) ?? [];
    arr.push(rule);
    uncoveredByDomain.set(rule.domain, arr);
  }
  for (const [domain, rules] of uncoveredByDomain) {
    if (rules.length >= threshold) {
      suggestions.push({
        kind: "consolidate",
        description: `Combine ${rules.length} ${domain} filters into one *@${domain} rule`,
        removeFilterIds: rules.map((r) => r.id),
        createFilter: domainBlockFilter(domain),
      });
    }
  }

  // A filter id can be flagged by more than one pass (e.g. three identical
  // single-address filters are both a "duplicate" set and a "consolidate"
  // set). Claim each id for the first suggestion that references it so the
  // accepted set never asks to delete the same filter twice.
  const claimed = new Set<string>();
  const deduped: FilterOptimisation[] = [];
  for (const suggestion of suggestions) {
    const removeFilterIds = suggestion.removeFilterIds.filter((id) => !claimed.has(id));
    for (const id of removeFilterIds) claimed.add(id);
    if (removeFilterIds.length === 0 && suggestion.createFilter === undefined) continue;
    deduped.push({ ...suggestion, removeFilterIds });
  }

  return deduped;
}

export interface OptimiseApplyFailure {
  subject: string;
  error: string;
}

export interface OptimiseApplyResult {
  filtersCreated: number;
  filtersDeleted: number;
  failures: OptimiseApplyFailure[];
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Apply an accepted set of optimisations: create replacements first, then delete the
 * old. Best-effort like `reconcileNativeFilters` — a failed create/delete is recorded
 * and does not abort the remaining operations, so a transient failure partway through
 * can't leave an already-applied suggestion re-appliable.
 *
 * **Ownership is kept in step (#202).** A consolidation's replacement filter is created
 * by this app, so its id is recorded in `filterSyncState.managedFilterIds` — otherwise
 * the app's own broadest rule is untracked from birth: never cleanable by
 * `reconcileFilters` (#29), invisible to this tool's future passes (#190), and offered
 * back to the user as something to "adopt" (#80). Deleted ids are dropped from the set
 * in the same write, so the store doesn't claim filters that no longer exist until the
 * next `enforce()` prunes them.
 */
export async function applyFilterOptimisations(
  client: GmailClient,
  store: Store,
  optimisations: FilterOptimisation[],
): Promise<OptimiseApplyResult> {
  let filtersCreated = 0;
  let filtersDeleted = 0;
  const failures: OptimiseApplyFailure[] = [];
  const previousSync = await store.filterSync.get();
  const managedFilterIds = new Set(previousSync?.managedFilterIds ?? []);
  for (const opt of optimisations) {
    if (opt.createFilter !== undefined) {
      try {
        const created = await client.createFilter(opt.createFilter);
        managedFilterIds.add(created.id);
        filtersCreated += 1;
      } catch (error) {
        failures.push({ subject: `filter:${opt.createFilter.from}`, error: errMsg(error) });
      }
    }
    for (const id of opt.removeFilterIds) {
      try {
        await client.deleteFilter(id);
        managedFilterIds.delete(id);
        filtersDeleted += 1;
      } catch (error) {
        failures.push({ subject: `filter:${id}`, error: errMsg(error) });
      }
    }
  }

  await store.filterSync.put({
    key: FILTER_SYNC_KEY,
    lastSyncAt: previousSync?.lastSyncAt ?? null,
    // Tidying changes how many filters the account holds, so keep the soft-cap headroom
    // view honest rather than leaving the pre-tidy count until the next sync re-reads it.
    totalFilters: Math.max(0, (previousSync?.totalFilters ?? 0) + filtersCreated - filtersDeleted),
    managedFilterIds: [...managedFilterIds],
  });

  return { filtersCreated, filtersDeleted, failures };
}
