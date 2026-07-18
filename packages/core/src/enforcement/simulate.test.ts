// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import { createInMemoryStore, domainBuilder, senderBuilder, MockGmailClient } from "../testing";
import { estimateWeeklyVolume, simulateEnforcement } from "./simulate";

describe("estimateWeeklyVolume", () => {
  it("extrapolates weekly volume from the last-30-day count", () => {
    expect(estimateWeeklyVolume({ recencyBuckets: { d30: 30, d90: 0, d180: 0, older: 0 } })).toBe(
      7,
    );
    expect(estimateWeeklyVolume({ recencyBuckets: { d30: 0, d90: 9, d180: 0, older: 0 } })).toBe(0);
  });
});

describe("simulateEnforcement", () => {
  it("counts a new block: creates a filter and trashes existing mail, no mutation", async () => {
    const store = createInMemoryStore();
    const sender = senderBuilder("deals@retailco.com", { totalEmails: 5 });
    await store.senders.put(sender);
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: sender.id,
        scope: "address",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
    ]);

    expect(impact.filtersToCreate).toBe(1);
    expect(impact.filtersToDelete).toBe(0);
    // listMessageIdsForSender is queried for the count; no filters/labels were mutated.
    expect(gmail.createdFilters).toHaveLength(0);
    expect(gmail.batchModifyCalls).toHaveLength(0);
    expect(gmail.senderQueries).toContain("deals@retailco.com");
  });

  it("a prospective whole-domain trust drops a blocked member from the preview (#144)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("promo@shop.com", { trustStatus: "blocked" }));
    await store.domains.put(domainBuilder("shop.com")); // domain undecided (pending)
    const gmail = new MockGmailClient();

    // As-is, the standing block would compile a filter...
    const before = await simulateEnforcement(gmail, store, []);
    // ...but previewing a whole-domain trust makes the member effectively trusted → no filter.
    const after = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("shop.com"), scope: "domain", decision: "trust" },
    ]);

    expect(before.filtersToCreate).toBe(1);
    expect(after.filtersToCreate).toBe(0);
  });

  it("classifies archive vs delete from the staged actions", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("a@x.com"));
    await store.senders.put(senderBuilder("b@y.com"));
    const gmail = new MockGmailClient();
    // Two messages each so the count is observable.
    gmail.seedInbox([
      {
        id: "1",
        threadId: "t1",
        labelIds: ["INBOX"],
        internalDate: 0,
        headers: { from: "a@x.com" },
      },
      {
        id: "2",
        threadId: "t2",
        labelIds: ["INBOX"],
        internalDate: 0,
        headers: { from: "a@x.com" },
      },
      {
        id: "3",
        threadId: "t3",
        labelIds: ["INBOX"],
        internalDate: 0,
        headers: { from: "b@y.com" },
      },
    ]);

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("a@x.com"), scope: "address", decision: "block", actions: ["archive"] },
      { subjectId: keyFor("b@y.com"), scope: "address", decision: "block", actions: ["delete"] },
    ]);

    expect(impact.messagesToArchive).toBe(2);
    expect(impact.messagesToDelete).toBe(1);
  });

  it("counts filters removed when reversing a block to trust", async () => {
    const store = createInMemoryStore();
    // A currently-blocked sender whose filter exists in Gmail.
    await store.senders.put(senderBuilder("spam@x.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "f1", from: "spam@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    // The filter was created by this app in an earlier run, so it's tracked as managed.
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["f1"],
    });

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("spam@x.com"), scope: "address", decision: "trust" },
    ]);

    expect(impact.filtersToDelete).toBe(1);
    expect(impact.filtersToCreate).toBe(0);
    expect(gmail.deletedFilterIds).toHaveLength(0); // no mutation
  });

  it("never previews deleting a foreign filter sharing the block action shape (#29)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    // Hand-built by the user in Gmail's own UI — no managed-filter record for it.
    gmail.seedFilters([
      {
        id: "hand-made",
        from: "oldjob@company.com",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);

    const impact = await simulateEnforcement(gmail, store, []);

    expect(impact.filtersToDelete).toBe(0);
  });

  it("counts spam-marked mail that a trust reversal would rescue", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("news@x.com", { trustStatus: "blocked", spamMarkedCount: 4 }),
    );
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("news@x.com"), scope: "address", decision: "trust" },
    ]);

    expect(impact.messagesToRescue).toBe(4);
  });

  it("previews a whole-domain block", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("promo.com"));
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("promo.com"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "archive"],
      },
    ]);

    expect(impact.filtersToCreate).toBe(1);
    expect(gmail.senderQueries).toContain("*@promo.com");
  });
});
