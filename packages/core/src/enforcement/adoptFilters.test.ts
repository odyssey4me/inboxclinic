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
    await store.senders.put(senderBuilder("spam@a.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("hand-made", "spam@a.test")]);

    const suggestions = await suggestFilterAdoptions(gmail, store);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.filterId).toBe("hand-made");
    expect(suggestions[0]?.from).toBe("spam@a.test");
    expect(suggestions[0]?.description).toContain("spam@a.test");
  });

  it("does not suggest adopting a filter for a sender the domain now trusts (#144)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("promo@shop.test", { trustStatus: "blocked" }));
    await store.domains.put(
      domainBuilder("shop.test", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("hand-made", "promo@shop.test")]);

    // The sender is effectively trusted, so its filter isn't desired → nothing to adopt.
    expect(await suggestFilterAdoptions(gmail, store)).toEqual([]);
  });

  it("threads a domain's exception exclusion into adoption matching (#145)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("shop.test", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["vip@shop.test"],
      }),
    );
    await store.senders.put(
      senderBuilder("vip@shop.test", { trustStatus: "trusted", decisionScope: "address" }),
    );
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      {
        id: "hand",
        from: "*@shop.test",
        excludeFrom: "vip@shop.test",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);

    // The desired domain filter carries excludeFrom → it matches the hand-made carved filter.
    const suggestions = await suggestFilterAdoptions(gmail, store);
    expect(suggestions.map((s) => s.filterId)).toEqual(["hand"]);
  });

  it("does not suggest a filter that is already tracked as managed", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.test", { trustStatus: "blocked" }));
    await store.filterSync.put({
      key: FILTER_SYNC_KEY,
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["already-managed"],
      enumeratedDomains: [],
    });
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("already-managed", "spam@a.test")]);

    expect(await suggestFilterAdoptions(gmail, store)).toEqual([]);
  });

  it("does not suggest a foreign filter with no matching desired criteria", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("foreign", "boss@work.test")]);

    expect(await suggestFilterAdoptions(gmail, store)).toEqual([]);
  });
});

describe("applyFilterAdoptions", () => {
  it("records accepted adoptions into managedFilterIds without mutating Gmail", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("hand-made", "spam@a.test")]);

    const result = await applyFilterAdoptions(store, [
      { filterId: "hand-made", from: "spam@a.test", description: "adopt it" },
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
    await store.senders.put(senderBuilder("spam@a.test", { trustStatus: "blocked" }));
    await store.filterSync.put({
      key: FILTER_SYNC_KEY,
      lastSyncAt: 1000,
      totalFilters: 2,
      managedFilterIds: ["existing"],
      enumeratedDomains: [],
    });

    await applyFilterAdoptions(store, [
      { filterId: "newly-adopted", from: "spam@a.test", description: "adopt it" },
    ]);

    const sync = await store.filterSync.get();
    expect(sync?.managedFilterIds.sort()).toEqual(["existing", "newly-adopted"]);
    expect(sync?.lastSyncAt).toBe(1000);
    expect(sync?.totalFilters).toBe(2);
  });

  it("drops an adoption whose sender was unblocked since it was suggested (#89)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("hand-made", "spam@a.test")]);

    const suggestions = await suggestFilterAdoptions(gmail, store);
    expect(suggestions).toHaveLength(1);

    // Unblocked between "Check" and "Adopt" — the filter no longer matches anything.
    await store.senders.put(senderBuilder("spam@a.test", { trustStatus: "trusted" }));

    const result = await applyFilterAdoptions(store, suggestions);

    expect(result.adopted).toBe(0);
    expect(result.skipped).toBe(1);
    const sync = await store.filterSync.get();
    expect(sync?.managedFilterIds ?? []).toEqual([]);
  });

  it("adopts the ones that still match and skips only the ones that don't", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.test", { trustStatus: "blocked" }));
    await store.senders.put(senderBuilder("junk@b.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([block("still-blocked", "spam@a.test"), block("now-unblocked", "junk@b.test")]);

    const suggestions = await suggestFilterAdoptions(gmail, store);
    expect(suggestions).toHaveLength(2);

    await store.senders.put(senderBuilder("junk@b.test", { trustStatus: "trusted" }));

    const result = await applyFilterAdoptions(store, suggestions);

    expect(result.adopted).toBe(1);
    expect(result.skipped).toBe(1);
    const sync = await store.filterSync.get();
    expect(sync?.managedFilterIds).toEqual(["still-blocked"]);
  });
});
