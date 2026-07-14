// SPDX-License-Identifier: Apache-2.0
/**
 * Confirm-first adoption of untracked filters that already match a desired one —
 * docs/design-gmail-integration.md Decision 10. `reconcileFilters` refuses to guess
 * ownership from action shape in either direction (#29): it neither deletes an
 * untracked filter nor silently adopts one, even when its criteria + action already
 * match a desired filter, which otherwise leaves a duplicate `toCreate` gap. This
 * module surfaces those matches as a suggestion; adoption only happens once the user
 * explicitly accepts it, mirroring `optimiseFilters.ts`'s suggest/apply split.
 */

import { compileFilters, reconcileFilters, type CompileFiltersOptions } from "./compileFilters";
import { FILTER_SYNC_KEY } from "./enforce";
import type { GmailClient } from "../ports/GmailClient";
import type { Store } from "../store";

export interface FilterAdoption {
  /** The existing Gmail filter's id. */
  filterId: string;
  /** The filter's `from` criteria, for display. */
  from: string;
  description: string;
}

/**
 * Read-only: find untracked existing filters that already cover a currently-desired
 * block filter, so adopting them (instead of creating a duplicate) can be offered.
 */
export async function suggestFilterAdoptions(
  client: GmailClient,
  store: Store,
  options: CompileFiltersOptions = {},
): Promise<FilterAdoption[]> {
  const blockedSenders = await store.senders.query({ trustStatus: "blocked" });
  const blockedDomains = await store.domains.query({ trustStatus: "blocked" });
  const compiled = compileFilters(blockedSenders, blockedDomains, options);

  const existing = await client.listFilters();
  const previousSync = await store.filterSync.get();
  const managedFilterIds = new Set(previousSync?.managedFilterIds ?? []);

  const { adoptable } = reconcileFilters(compiled.filters, existing, managedFilterIds);
  return adoptable.map((filter) => ({
    filterId: filter.id,
    from: filter.from,
    description: `Adopt the existing "${filter.from}" filter instead of creating a duplicate`,
  }));
}

/**
 * Record accepted adoptions as managed — no Gmail mutation is needed since the filter
 * already has the desired criteria + action; it only becomes eligible for future
 * reconciliation (including deletion once no longer desired) once its id is tracked.
 */
export async function applyFilterAdoptions(
  store: Store,
  adoptions: ReadonlyArray<FilterAdoption>,
): Promise<{ adopted: number }> {
  const previousSync = await store.filterSync.get();
  const managedFilterIds = new Set(previousSync?.managedFilterIds ?? []);
  for (const adoption of adoptions) managedFilterIds.add(adoption.filterId);

  await store.filterSync.put({
    key: FILTER_SYNC_KEY,
    lastSyncAt: previousSync?.lastSyncAt ?? null,
    totalFilters: previousSync?.totalFilters ?? 0,
    managedFilterIds: [...managedFilterIds],
  });

  return { adopted: adoptions.length };
}
