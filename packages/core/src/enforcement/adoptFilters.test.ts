// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { applyFilterAdoptions, suggestFilterAdoptions } from "./adoptFilters";
import { FILTER_SYNC_KEY } from "./enforce";
import { createInMemoryStore, domainBuilder, MockGmailClient, senderBuilder } from "../testing";

const block = (id: string, from: string) => ({
  id,
  from,
  addLabelIds: ["TRASH"],
  removeLabelIds: ["INBOX"],
});

describe("suggestFilterAdoptions", () => {
  it("suggests adopting an untracked filter that already matches a desired one", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("hand-made", "spam@a.com")]);

    const suggestions = await suggestFilterAdoptions(gmail, store);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.filterId).toBe("hand-made");
    expect(suggestions[0]?.from).toBe("spam@a.com");
    expect(suggestions[0]?.description).toContain("spam@a.com");
  });

  it("does not suggest adopting a filter for a sender the domain now trusts (#144)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("promo@shop.com", { trustStatus: "blocked" }));
    await store.domains.put(
      domainBuilder("shop.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("hand-made", "promo@shop.com")]);

    // The sender is effectively trusted, so its filter isn't desired → nothing to adopt.
    expect(await suggestFilterAdoptions(gmail, store)).toEqual([]);
  });

  it("does not suggest a filter that is already tracked as managed", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "blocked" }));
    await store.filterSync.put({
      key: FILTER_SYNC_KEY,
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["already-managed"],
    });
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("already-managed", "spam@a.com")]);

    expect(await suggestFilterAdoptions(gmail, store)).toEqual([]);
  });

  it("does not suggest a foreign filter with no matching desired criteria", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("foreign", "boss@work.com")]);

    expect(await suggestFilterAdoptions(gmail, store)).toEqual([]);
  });
});

describe("applyFilterAdoptions", () => {
  it("records accepted adoptions into managedFilterIds without mutating Gmail", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("hand-made", "spam@a.com")]);

    const result = await applyFilterAdoptions(store, [
      { filterId: "hand-made", from: "spam@a.com", description: "adopt it" },
    ]);

    expect(result.adopted).toBe(1);
    expect(result.skipped).toBe(0);
    const sync = await store.filterSync.get();
    expect(sync?.managedFilterIds).toEqual(["hand-made"]);
    expect(gmail.createdFilters).toEqual([]);
    expect(gmail.deletedFilterIds).toEqual([]);
  });

  it("merges into any existing managed ids rather than replacing them", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "blocked" }));
    await store.filterSync.put({
      key: FILTER_SYNC_KEY,
      lastSyncAt: 1000,
      totalFilters: 2,
      managedFilterIds: ["existing"],
    });

    await applyFilterAdoptions(store, [
      { filterId: "newly-adopted", from: "spam@a.com", description: "adopt it" },
    ]);

    const sync = await store.filterSync.get();
    expect(sync?.managedFilterIds.sort()).toEqual(["existing", "newly-adopted"]);
    expect(sync?.lastSyncAt).toBe(1000);
    expect(sync?.totalFilters).toBe(2);
  });

  it("drops an adoption whose sender was unblocked since it was suggested (#89)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("hand-made", "spam@a.com")]);

    const suggestions = await suggestFilterAdoptions(gmail, store);
    expect(suggestions).toHaveLength(1);

    // Unblocked between "Check" and "Adopt" — the filter no longer matches anything.
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "trusted" }));

    const result = await applyFilterAdoptions(store, suggestions);

    expect(result.adopted).toBe(0);
    expect(result.skipped).toBe(1);
    const sync = await store.filterSync.get();
    expect(sync?.managedFilterIds ?? []).toEqual([]);
  });

  it("adopts the ones that still match and skips only the ones that don't", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "blocked" }));
    await store.senders.put(senderBuilder("junk@b.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("still-blocked", "spam@a.com"), block("now-unblocked", "junk@b.com")]);

    const suggestions = await suggestFilterAdoptions(gmail, store);
    expect(suggestions).toHaveLength(2);

    await store.senders.put(senderBuilder("junk@b.com", { trustStatus: "trusted" }));

    const result = await applyFilterAdoptions(store, suggestions);

    expect(result.adopted).toBe(1);
    expect(result.skipped).toBe(1);
    const sync = await store.filterSync.get();
    expect(sync?.managedFilterIds).toEqual(["still-blocked"]);
  });
});
