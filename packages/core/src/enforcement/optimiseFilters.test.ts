// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { suggestFilterAdoptions } from "./adoptFilters";
import { FILTER_SYNC_KEY, reconcileNativeFilters } from "./enforce";
import { applyFilterOptimisations, suggestFilterOptimisations } from "./optimiseFilters";
import { createInMemoryStore, MockGmailClient, senderBuilder } from "../testing";
import type { Store } from "../store";

const block = (id: string, from: string) => ({
  id,
  from,
  addLabelIds: ["TRASH"],
  removeLabelIds: ["INBOX"],
});

const carved = (id: string, from: string, excludeFrom: string) => ({
  id,
  from,
  excludeFrom,
  addLabelIds: ["TRASH"],
  removeLabelIds: ["INBOX"],
});

/** A store claiming `managedFilterIds` as this app's own (the #29 ownership marker). */
async function storeOwning(...managedFilterIds: string[]): Promise<Store> {
  const store = createInMemoryStore();
  await store.filterSync.put({
    key: FILTER_SYNC_KEY,
    lastSyncAt: null,
    totalFilters: managedFilterIds.length,
    managedFilterIds,
  });
  return store;
}

describe("suggestFilterOptimisations", () => {
  it("does not treat differently-excluded domain filters as duplicates (#145)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("plain", "*@shop.com"),
      carved("carve", "*@shop.com", "vip@shop.com"),
    ]);
    const store = await storeOwning("plain", "carve");

    const out = await suggestFilterOptimisations(gmail, store);

    expect(out.filter((o) => o.kind === "duplicate")).toEqual([]);
  });

  it("does not flag an excluded address as redundant under its domain filter (#145)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      carved("dom", "*@shop.com", "vip@shop.com"),
      block("vip", "vip@shop.com"), // the carved-out address — still doing real work
      block("junk", "junk@shop.com"), // genuinely covered by the domain rule
    ]);
    const store = await storeOwning("dom", "vip", "junk");

    const out = await suggestFilterOptimisations(gmail, store);

    const redundant = out.filter((o) => o.kind === "redundant").flatMap((o) => o.removeFilterIds);
    expect(redundant).toEqual(["junk"]);
  });

  it("suggests consolidating several same-domain address filters into a domain rule", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
      block("f4", "keep@other.com"),
    ]);
    const store = await storeOwning("f1", "f2", "f3", "f4");

    const out = await suggestFilterOptimisations(gmail, store);
    const consolidate = out.find((o) => o.kind === "consolidate");
    expect(consolidate?.createFilter?.from).toBe("*@spam.com");
    expect(consolidate?.removeFilterIds.sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("flags duplicate filters", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("f1", "dupe@x.com"), block("f2", "dupe@x.com")]);
    const store = await storeOwning("f1", "f2");

    const dup = (await suggestFilterOptimisations(gmail, store)).find(
      (o) => o.kind === "duplicate",
    );
    expect(dup?.removeFilterIds).toEqual(["f2"]);
  });

  it("flags an address filter already covered by a domain filter as redundant", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("f1", "*@ads.com"), block("f2", "promo@ads.com")]);
    const store = await storeOwning("f1", "f2");

    const redundant = (await suggestFilterOptimisations(gmail, store)).find(
      (o) => o.kind === "redundant",
    );
    expect(redundant?.removeFilterIds).toEqual(["f2"]);
  });

  it("ignores non-block filters and tidy accounts", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "s1", from: "friend@x.com", addLabelIds: ["STARRED"], removeLabelIds: [] },
      block("f1", "a@x.com"),
      block("f2", "b@y.com"),
    ]);
    const store = await storeOwning("s1", "f1", "f2");

    expect(await suggestFilterOptimisations(gmail, store)).toHaveLength(0);
  });

  // --- Ownership gate (#29, re-applied to this path by #190) -------------------

  it("never offers an untracked filter for deletion, whatever its shape (#190)", async () => {
    const gmail = new MockGmailClient();
    // Every optimisation pass has bait here: a duplicate pair, an address rule covered by
    // a domain rule, and three same-domain address rules ripe for consolidation. All were
    // built by hand in Gmail, so none is tracked.
    gmail.seedFilters([
      block("hand-1", "dupe@x.com"),
      block("hand-2", "dupe@x.com"),
      block("hand-3", "*@ads.com"),
      block("hand-4", "promo@ads.com"),
      block("hand-5", "a@spam.com"),
      block("hand-6", "b@spam.com"),
      block("hand-7", "c@spam.com"),
    ]);
    const store = await storeOwning(); // nothing managed

    expect(await suggestFilterOptimisations(gmail, store)).toEqual([]);
  });

  it("offers only the tracked filters when hand-built ones share the domain (#190)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("ours-1", "a@spam.com"),
      block("ours-2", "b@spam.com"),
      block("ours-3", "c@spam.com"),
      block("hand-1", "d@spam.com"), // same domain, but the user's own
    ]);
    const store = await storeOwning("ours-1", "ours-2", "ours-3");

    const out = await suggestFilterOptimisations(gmail, store);

    const consolidate = out.find((o) => o.kind === "consolidate");
    expect(consolidate?.createFilter?.from).toBe("*@spam.com");
    expect(consolidate?.removeFilterIds.sort()).toEqual(["ours-1", "ours-2", "ours-3"]);
    expect(out.flatMap((o) => o.removeFilterIds)).not.toContain("hand-1");
  });

  it("does not consolidate when too few of the address rules are tracked (#190)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("ours-1", "a@spam.com"),
      block("hand-1", "b@spam.com"),
      block("hand-2", "c@spam.com"),
    ]);
    // Only one of the three is ours — below the threshold once untracked rules don't count.
    const store = await storeOwning("ours-1");

    expect(await suggestFilterOptimisations(gmail, store)).toEqual([]);
  });

  it("keeps a tracked duplicate as the survivor and leaves the hand-built copy (#190)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("hand-1", "dupe@x.com"),
      block("ours-1", "dupe@x.com"),
      block("ours-2", "dupe@x.com"),
    ]);
    const store = await storeOwning("ours-1", "ours-2");

    const dup = (await suggestFilterOptimisations(gmail, store)).find(
      (o) => o.kind === "duplicate",
    );

    // One of ours survives so the rule stays tracked; the user's copy is untouched.
    expect(dup?.removeFilterIds).toEqual(["ours-2"]);
    expect(dup?.description).toContain("remove 1 duplicate");
  });

  it("still counts an untracked domain rule as coverage for a tracked address rule (#190)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("hand-1", "*@ads.com"), // hand-built, but genuinely covers the address below
      block("ours-1", "promo@ads.com"),
    ]);
    const store = await storeOwning("ours-1");

    const redundant = (await suggestFilterOptimisations(gmail, store)).find(
      (o) => o.kind === "redundant",
    );
    expect(redundant?.removeFilterIds).toEqual(["ours-1"]);
  });

  it("offers nothing when the store has no filter-sync state at all (#190)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("f1", "dupe@x.com"), block("f2", "dupe@x.com")]);

    expect(await suggestFilterOptimisations(gmail, createInMemoryStore())).toEqual([]);
  });

  // --- Apply ------------------------------------------------------------------

  it("applyFilterOptimisations creates the replacement then deletes the old filters", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
    ]);
    const store = await storeOwning("f1", "f2", "f3");

    const suggestions = await suggestFilterOptimisations(gmail, store);
    const result = await applyFilterOptimisations(gmail, store, suggestions);

    expect(result.filtersCreated).toBe(1);
    expect(result.filtersDeleted).toBe(3);
    expect(result.failures).toEqual([]);
    expect(gmail.createdFilters).toEqual([
      { from: "*@spam.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    expect(gmail.deletedFilterIds.sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("records the consolidated filter as managed and drops the removed ids (#202)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
    ]);
    const store = await storeOwning("f1", "f2", "f3");

    const suggestions = await suggestFilterOptimisations(gmail, store);
    await applyFilterOptimisations(gmail, store, suggestions);

    const created = (await gmail.listFilters()).find((f) => f.from === "*@spam.com");
    const sync = await store.filterSync.get();
    // The replacement this app just created is tracked, and the filters it removed are gone
    // from the set rather than lingering until the next enforce() prunes them.
    expect(sync?.managedFilterIds).toEqual([created?.id]);
    expect(sync?.totalFilters).toBe(1);
  });

  it("never offers to adopt the filter the tidy-up just created (#202)", async () => {
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
    ]);
    const store = await storeOwning("f1", "f2", "f3");
    for (const email of ["a@spam.com", "b@spam.com", "c@spam.com"]) {
      await store.senders.put(senderBuilder(email, { trustStatus: "blocked" }));
    }

    await applyFilterOptimisations(gmail, store, await suggestFilterOptimisations(gmail, store));

    // Untracked, the new *@spam.com rule would match a desired filter with no managed id —
    // so the app would offer to "adopt" a filter it created itself moments earlier (#80).
    expect(await suggestFilterAdoptions(gmail, store)).toEqual([]);

    // And because consolidation shares compileFilters' domain threshold, the tidy-up is what
    // enforce would compile from the standing blocks anyway: the next sync leaves it alone.
    const outcome = await reconcileNativeFilters(gmail, store);
    expect(outcome.filtersCreated).toBe(0);
    expect(outcome.filtersDeleted).toBe(0);
  });

  it("does not claim ownership of a replacement whose create failed (#202)", async () => {
    class FlakyClient extends MockGmailClient {
      override createFilter(): never {
        throw new Error("boom");
      }
    }
    const gmail = new FlakyClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
    ]);
    const store = await storeOwning("f1", "f2", "f3");

    await applyFilterOptimisations(gmail, store, await suggestFilterOptimisations(gmail, store));

    expect((await store.filterSync.get())?.managedFilterIds).toEqual([]);
  });

  it("dedupes filter ids referenced by both the duplicate and consolidate passes", async () => {
    const gmail = new MockGmailClient();
    // Three byte-for-byte identical single-address filters: flagged as a
    // "duplicate" set (keep f1) AND as a "consolidate" set (all three), since
    // they're also three uncovered address rules for the same domain.
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "a@spam.com"),
      block("f3", "a@spam.com"),
    ]);
    const store = await storeOwning("f1", "f2", "f3");

    const suggestions = await suggestFilterOptimisations(gmail, store);
    const referenced = suggestions.flatMap((s) => s.removeFilterIds);

    // No id appears in more than one suggestion's removeFilterIds.
    expect(new Set(referenced).size).toBe(referenced.length);

    const result = await applyFilterOptimisations(gmail, store, suggestions);
    expect(result.filtersDeleted).toBe(3);
    expect(gmail.deletedFilterIds.sort()).toEqual(["f1", "f2", "f3"]);
    // Each id was deleted exactly once.
    expect(gmail.deletedFilterIds).toHaveLength(new Set(gmail.deletedFilterIds).size);
  });

  it("applyFilterOptimisations is best-effort — a failing delete is recorded, not thrown", async () => {
    class FlakyClient extends MockGmailClient {
      override deleteFilter(id: string): Promise<void> {
        if (id === "f2") throw new Error("boom");
        return super.deleteFilter(id);
      }
    }
    const gmail = new FlakyClient();
    gmail.seedFilters([block("f1", "dupe@x.com"), block("f2", "dupe@x.com")]);
    const store = await storeOwning("f1", "f2");

    const suggestions = await suggestFilterOptimisations(gmail, store);
    const result = await applyFilterOptimisations(gmail, store, suggestions);

    expect(result.filtersDeleted).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({ subject: "filter:f2", error: "boom" });
  });

  it("applyFilterOptimisations continues past a failed create to still delete the old filters", async () => {
    class FlakyClient extends MockGmailClient {
      override createFilter(): never {
        throw new Error("boom");
      }
    }
    const gmail = new FlakyClient();
    gmail.seedFilters([
      block("f1", "a@spam.com"),
      block("f2", "b@spam.com"),
      block("f3", "c@spam.com"),
    ]);
    const store = await storeOwning("f1", "f2", "f3");

    const suggestions = await suggestFilterOptimisations(gmail, store);
    const result = await applyFilterOptimisations(gmail, store, suggestions);

    expect(result.filtersCreated).toBe(0);
    expect(result.filtersDeleted).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual({ subject: "filter:*@spam.com", error: "boom" });
  });
});
