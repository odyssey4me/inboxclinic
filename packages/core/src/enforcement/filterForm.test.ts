// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { createInMemoryStore } from "../testing";
import { enumeratedFormOf, withCurrentFilterForm } from "./filterForm";
import { FILTER_SYNC_KEY } from "./enforce";
import type { CompiledFilters } from "./compileFilters";
import type { Store } from "../store";

async function storeEnumerating(...enumeratedDomains: string[]): Promise<Store> {
  const store = createInMemoryStore();
  await store.filterSync.put({
    key: FILTER_SYNC_KEY,
    lastSyncAt: null,
    totalFilters: 0,
    managedFilterIds: [],
    enumeratedDomains,
  });
  return store;
}

const compiled = (overflows: CompiledFilters["exceptionOverflows"]): CompiledFilters => ({
  filters: [],
  capReached: false,
  skippedAtCap: 0,
  exceptionOverflows: overflows,
});

describe("withCurrentFilterForm", () => {
  it("reads the persisted form so every compile site sees the same one", async () => {
    const store = await storeEnumerating("shop.test");

    // The reason this is a shared helper and not four independent derivations: a preview that
    // compiles against a different form than the apply is the #192/#218/#221 failure mode.
    expect(await withCurrentFilterForm(store)).toEqual({ enumeratedDomains: ["shop.test"] });
  });

  it("keeps the caller's other compile options intact", async () => {
    const store = await storeEnumerating("shop.test");

    expect(await withCurrentFilterForm(store, { maxCriteriaChars: 40 })).toEqual({
      maxCriteriaChars: 40,
      enumeratedDomains: ["shop.test"],
    });
  });

  it("treats an unwritten sync record as nothing enumerated", async () => {
    // A first run has no record; the dead band then has no effect, which is the pre-#208
    // behaviour rather than an error.
    expect(await withCurrentFilterForm(createInMemoryStore())).toEqual({ enumeratedDomains: [] });
  });

  it("lets an explicit form win, so tests and tooling can pin it", async () => {
    const store = await storeEnumerating("shop.test");

    expect(await withCurrentFilterForm(store, { enumeratedDomains: [] })).toEqual({
      enumeratedDomains: [],
    });
  });
});

describe("enumeratedFormOf", () => {
  it("records the domains actually compiled in the enumerate form", () => {
    expect(
      enumeratedFormOf(
        compiled([{ domain: "shop.test", strategy: "enumerate", exceptionCount: 100 }]),
      ),
    ).toEqual(["shop.test"]);
  });

  it("excludes a dropped block, which is a missing member list rather than a form", () => {
    // Recording it would hold the domain at the lower promote threshold for a reason that has
    // nothing to do with its carve-out ever having been too long.
    expect(
      enumeratedFormOf(
        compiled([{ domain: "shop.test", strategy: "dropped", exceptionCount: 100 }]),
      ),
    ).toEqual([]);
  });

  it("is empty when nothing overflowed", () => {
    expect(enumeratedFormOf(compiled([]))).toEqual([]);
  });
});
