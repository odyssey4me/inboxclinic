// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import {
  createInMemoryStore,
  domainBuilder,
  messageMetaBuilder,
  senderBuilder,
  MockGmailClient,
} from "../testing";
import { estimateWeeklyVolume, simulateEnforcement } from "./simulate";
import type { MessageMeta } from "../ports/GmailClient";

const msgFrom = (from: string): MessageMeta => messageMetaBuilder({ headers: { from } });

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

  it("keeps a domain filter's exception carve-out in the preview, so it doesn't churn (#145)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("shop.com", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["vip@shop.com"],
      }),
    );
    await store.senders.put(
      senderBuilder("vip@shop.com", { trustStatus: "trusted", decisionScope: "address" }),
    );
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      {
        id: "f1",
        from: "*@shop.com",
        excludeFrom: "vip@shop.com",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["f1"],
    });

    const impact = await simulateEnforcement(gmail, store, []);

    // The previewed desired filter carries the same exclusion as the existing one → no churn.
    expect(impact.filtersToCreate).toBe(0);
    expect(impact.filtersToDelete).toBe(0);
  });

  it("reflects a batch address-trust as a new exception carve-out on a blocked domain (#161)", async () => {
    const store = createInMemoryStore();
    // shop.com is already blocked at domain scope, with NO stored exceptions yet.
    await store.domains.put(
      domainBuilder("shop.com", { trustStatus: "blocked", decisionScope: "domain" }),
    );
    await store.senders.put(senderBuilder("promo@shop.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    // The managed filter is the plain domain block, no carve-out.
    gmail.seedFilters([
      { id: "f1", from: "*@shop.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["f1"],
    });

    // Previewing "trust promo@shop.com" would (in the real apply) record it as a domain
    // exception, so the desired filter gains a negatedQuery carve-out and the plain one is
    // replaced — the preview must reflect that, not read the stored (empty) exception set.
    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("promo@shop.com"), scope: "address", decision: "trust" },
    ]);

    expect(impact.filtersToDelete).toBe(1); // the plain *@shop.com filter
    expect(impact.filtersToCreate).toBe(1); // replaced by *@shop.com carrying the carve-out
  });

  it("excludes a batch-trusted member from a same-batch domain block's message estimate (#161)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(domainBuilder("shop.com")); // pending; blocked in the batch below
    await store.senders.put(senderBuilder("keep@shop.com", { trustStatus: "pending" }));
    const gmail = new MockGmailClient([msgFrom("promo@shop.com"), msgFrom("keep@shop.com")]);

    // "Block the domain but keep this sender" in one batch: the member becomes a domain
    // exception, so its existing mail is not swept. (The preview models this intended end
    // state; the real apply reaches it when the domain decision establishes domain scope.)
    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("shop.com"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
      { subjectId: keyFor("keep@shop.com"), scope: "address", decision: "trust" },
    ]);

    expect(impact.messagesToDelete).toBe(1); // only promo@shop.com; keep@shop.com is carved out
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

  it("treats a defer on an already-decided sender as a no-op, not a reversal (#148)", async () => {
    const store = createInMemoryStore();
    // A currently-blocked sender whose managed filter exists in Gmail.
    await store.senders.put(senderBuilder("spam@x.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "f1", from: "spam@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["f1"],
    });

    // Previewing "not sure" (defer) must leave the block intact — the real apply is a no-op,
    // so the preview must not show the filter being removed.
    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("spam@x.com"), scope: "address", decision: "defer" },
    ]);

    expect(impact.filtersToDelete).toBe(0);
    expect(impact.filtersToCreate).toBe(0);
  });

  it("treats a defer on an already-blocked domain as a no-op (#148)", async () => {
    const store = createInMemoryStore();
    // A currently-blocked domain whose managed wildcard filter exists in Gmail.
    await store.domains.put(domainBuilder("promo.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "d1", from: "*@promo.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    await store.filterSync.put({
      key: "filterSyncState",
      lastSyncAt: null,
      totalFilters: 1,
      managedFilterIds: ["d1"],
    });

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("promo.com"), scope: "domain", decision: "defer" },
    ]);

    expect(impact.filtersToDelete).toBe(0);
    expect(impact.filtersToCreate).toBe(0);
  });

  it("previews a defer on a still-pending sender as no change (#148)", async () => {
    const store = createInMemoryStore();
    // Pending, no filter anywhere — a defer keeps it pending, so nothing is created or removed.
    await store.senders.put(senderBuilder("maybe@x.com", { trustStatus: "pending" }));
    const gmail = new MockGmailClient();

    const impact = await simulateEnforcement(gmail, store, [
      { subjectId: keyFor("maybe@x.com"), scope: "address", decision: "defer" },
    ]);

    expect(impact).toEqual({
      filtersToCreate: 0,
      filtersToDelete: 0,
      messagesToArchive: 0,
      messagesToDelete: 0,
      messagesToRescue: 0,
    });
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

  it("excludes a domain's trusted exception from the block's message estimate (#151)", async () => {
    const store = createInMemoryStore();
    // A blocked domain with one trusted exception address carved out.
    await store.domains.put(
      domainBuilder("shop.com", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["vip@shop.com"],
      }),
    );
    await store.senders.put(
      senderBuilder("vip@shop.com", { trustStatus: "trusted", decisionScope: "address" }),
    );
    // Two messages from an ordinary domain member + one from the trusted exception.
    const gmail = new MockGmailClient([
      msgFrom("promo@shop.com"),
      msgFrom("promo@shop.com"),
      msgFrom("vip@shop.com"),
    ]);

    const impact = await simulateEnforcement(gmail, store, [
      {
        subjectId: keyFor("shop.com"),
        scope: "domain",
        decision: "block",
        actions: ["create_filter", "delete"],
      },
    ]);

    // The exception's message is not counted — only the two non-exception messages, matching
    // what enforce's exception-excluding sweep would actually trash.
    expect(impact.messagesToDelete).toBe(2);
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
