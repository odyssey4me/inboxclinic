// SPDX-License-Identifier: Apache-2.0
/**
 * Which **form** each domain's block is currently compiled in — the one piece of state
 * `compileFilters` cannot derive for itself (#208).
 *
 * A blocked domain with trusted exceptions compiles either to a single `*@domain` filter with a
 * `negatedQuery`, or — when that carve-out overflows one filter's criteria budget — to the
 * **enumerate form**: one `from:<address>` filter per still-blocked member (#191). Switching
 * between them is not a small edit: one way deletes 1 filter and creates N, the other deletes N
 * and creates 1. A domain sitting on the boundary would therefore churn on every exception
 * change, so the compiler applies a dead band (`ENUMERATE_PROMOTE_RATIO`) — which requires
 * knowing where the domain already is.
 *
 * `compileFilters` is pure and sees only the desired state, so it is **told**. This module is
 * the only place that answer is read, and the only place the next one is derived:
 *
 * - `withCurrentFilterForm` — read it out of `filterSyncState` and fold it into the compile
 *   options;
 * - `enumeratedFormOf` — derive the form a compile actually produced, for persisting after a
 *   reconcile applies it.
 *
 * **Why one shared reader rather than each call site working it out.** The alternative was to
 * infer the current form from the account's filters at each of the four `compileFilters` call
 * sites. Independent consumers re-deriving the same fact is precisely the shape that produced
 * three separate preview/apply divergences here (#192, #218, #221): a preview that says "1
 * filter" and an apply that creates 12 is worse than either form on its own. One stored value,
 * read one way, cannot drift between call sites.
 *
 * **Drift against Gmail is self-correcting**, and deliberately tolerated. The stored form picks
 * the desired *shape*; it never asserts what exists. If it says enumerated and Gmail holds the
 * broad filter, the next reconcile converges anyway — a stale entry only biases a domain
 * towards *staying* enumerated, and the promote check releases it as soon as the carve-out is
 * comfortably under budget.
 */

import type { CompiledFilters, CompileFiltersOptions } from "./compileFilters";
import type { Store } from "../store";

/**
 * Fold the account's current filter form into compile options. Every `compileFilters` caller
 * goes through this, so a preview and the apply that follows always compile against the same
 * dead-band input.
 *
 * An explicit `enumeratedDomains` in `options` wins — tests and tooling can pin the form —
 * otherwise it comes from the store, and an unwritten record means "nothing is enumerated",
 * which is the pre-#208 behaviour.
 */
export async function withCurrentFilterForm(
  store: Store,
  options: CompileFiltersOptions = {},
): Promise<CompileFiltersOptions> {
  if (options.enumeratedDomains !== undefined) return options;
  const sync = await store.filterSync.get();
  return { ...options, enumeratedDomains: sync?.enumeratedDomains ?? [] };
}

/**
 * The enumerate-form domains a compile actually produced — what to persist once a reconcile has
 * applied it.
 *
 * Only `strategy: "enumerate"` counts. `"dropped"` means no member list was supplied to
 * enumerate from, which is a missing-input condition rather than a form the account is in;
 * recording it would hold a domain at the lower promote threshold for a reason unrelated to its
 * carve-out ever having been too long.
 */
export function enumeratedFormOf(compiled: CompiledFilters): string[] {
  return compiled.exceptionOverflows
    .filter((overflow) => overflow.strategy === "enumerate")
    .map((overflow) => overflow.domain);
}
