// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { enforce, FILTER_SYNC_KEY } from "./enforce";
import {
  createInMemoryStore,
  domainBuilder,
  messageMetaBuilder,
  MockGmailClient,
  senderBuilder,
} from "../testing";
import type { FilterSpec, MessageMeta } from "../ports/GmailClient";

const NOW = 1_700_000_000_000;

/** A message from a given sender, so `listMessageIdsForSender` can match it. */
const msgFrom = (from: string): MessageMeta => messageMetaBuilder({ headers: { from } });

describe("enforce", () => {
  it("reconciles a block into a native filter and archives existing mail", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("spam@a.com", {
        trustStatus: "blocked",
        pendingActions: ["create_filter", "archive"],
      }),
    );
    const gmail = new MockGmailClient([msgFrom("spam@a.com"), msgFrom("spam@a.com")]);

    const result = await enforce(gmail, store, { now: NOW });

    expect(gmail.createdFilters).toEqual<FilterSpec[]>([
      { from: "spam@a.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    expect(gmail.batchModifyCalls).toHaveLength(1);
    expect(gmail.batchModifyCalls[0]?.edit).toEqual({ addLabelIds: [], removeLabelIds: ["INBOX"] });
    expect(result.filtersCreated).toBe(1);
    expect(result.messagesArchived).toBe(2);
    expect(result.failures).toEqual([]);

    // pendingActions are cleared and sync state recorded.
    const sender = await store.senders.get(senderBuilder("spam@a.com").id);
    expect(sender?.pendingActions).toEqual([]);
    const sync = await store.filterSync.get();
    expect(sync).toEqual({
      key: FILTER_SYNC_KEY,
      lastSyncAt: NOW,
      totalFilters: 1,
      managedFilterIds: ["filter-1"],
    });
  });

  it("drops a per-sender block filter once the domain trusts that sender (#144)", async () => {
    const store = createInMemoryStore();
    // A sender blocked earlier, whose domain the user has since trusted at domain scope.
    await store.senders.put(senderBuilder("promo@shop.com", { trustStatus: "blocked" }));
    await store.domains.put(
      domainBuilder("shop.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    const gmail = new MockGmailClient();

    const result = await enforce(gmail, store, { now: NOW });

    // Effective status is trusted (domain overrides address), so no block filter is compiled.
    expect(gmail.createdFilters).toEqual([]);
    expect(result.filtersCreated).toBe(0);
  });

  it("keeps the block filter for an address that is an exception to the domain trust (#144)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("promo@shop.com", { trustStatus: "blocked" }));
    await store.domains.put(
      domainBuilder("shop.com", {
        trustStatus: "trusted",
        decisionScope: "domain",
        exceptionAddresses: ["promo@shop.com"],
      }),
    );
    const gmail = new MockGmailClient();

    const result = await enforce(gmail, store, { now: NOW });

    // The exception carves the address out of the domain trust, so its block still stands.
    expect(gmail.createdFilters).toEqual<FilterSpec[]>([
      { from: "promo@shop.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    expect(result.filtersCreated).toBe(1);
  });

  it("skips staged message actions for a sender the domain now trusts (#144)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("promo@shop.com", {
        trustStatus: "blocked",
        pendingActions: ["create_filter", "delete"],
      }),
    );
    await store.domains.put(
      domainBuilder("shop.com", { trustStatus: "trusted", decisionScope: "domain" }),
    );
    const gmail = new MockGmailClient([msgFrom("promo@shop.com"), msgFrom("promo@shop.com")]);

    const result = await enforce(gmail, store, { now: NOW });

    // Effectively trusted → no filter, and its staged trash action is not applied to its mail.
    expect(gmail.createdFilters).toEqual([]);
    expect(gmail.batchModifyCalls).toHaveLength(0);
    expect(result.messagesTrashed).toBe(0);
    expect(result.filtersCreated).toBe(0);
  });

  it("carves a trusted exception out of a blocked domain's filter and sweep, idempotently (#145)", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("shop.com", {
        trustStatus: "blocked",
        decisionScope: "domain",
        exceptionAddresses: ["vip@shop.com"],
        pendingActions: ["create_filter", "delete"],
      }),
    );
    // The exception address is trusted at address scope (overrides the domain block).
    await store.senders.put(
      senderBuilder("vip@shop.com", { trustStatus: "trusted", decisionScope: "address" }),
    );
    const gmail = new MockGmailClient([msgFrom("junk@shop.com"), msgFrom("vip@shop.com")]);

    const result = await enforce(gmail, store, { now: NOW });

    // The domain filter carries the exclusion...
    expect(gmail.createdFilters).toEqual<FilterSpec[]>([
      {
        from: "*@shop.com",
        excludeFrom: "vip@shop.com",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);
    // ...and the existing-mail sweep trashes junk@shop.com but NOT the exception vip@shop.com.
    expect(result.messagesTrashed).toBe(1);
    expect(gmail.batchModifyCalls.flatMap((c) => c.ids)).toHaveLength(1);

    // Idempotent: the excludeFrom round-trips, so a second run creates/deletes no filters.
    const again = await enforce(gmail, store, { now: NOW });
    expect(again.filtersCreated).toBe(0);
    expect(again.filtersDeleted).toBe(0);
  });

  it("is idempotent — a second run creates/deletes/modifies nothing", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("spam@a.com", {
        trustStatus: "blocked",
        pendingActions: ["create_filter", "delete"],
      }),
    );
    const gmail = new MockGmailClient([msgFrom("spam@a.com")]);

    await enforce(gmail, store, { now: NOW });
    const afterFirst = {
      created: gmail.createdFilters.length,
      modified: gmail.batchModifyCalls.length,
    };
    const second = await enforce(gmail, store, { now: NOW + 1000 });

    expect(gmail.createdFilters.length).toBe(afterFirst.created);
    expect(gmail.deletedFilterIds).toEqual([]);
    expect(gmail.batchModifyCalls.length).toBe(afterFirst.modified);
    expect(second.filtersCreated).toBe(0);
    expect(second.messagesTrashed).toBe(0);
  });

  it("delete staged → sends existing mail to Trash", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("junk@b.com", { trustStatus: "blocked", pendingActions: ["delete"] }),
    );
    const gmail = new MockGmailClient([msgFrom("junk@b.com")]);

    const result = await enforce(gmail, store, { now: NOW });

    expect(gmail.batchModifyCalls[0]?.edit).toEqual({
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX"],
    });
    expect(result.messagesTrashed).toBe(1);
  });

  it("aggregates 3+ blocked senders of a domain into one *@domain filter", async () => {
    const store = createInMemoryStore();
    for (const email of ["a@x.com", "b@x.com", "c@x.com"]) {
      await store.senders.put(senderBuilder(email, { trustStatus: "blocked" }));
    }
    const gmail = new MockGmailClient();

    await enforce(gmail, store, { now: NOW });

    expect(gmail.createdFilters).toEqual<FilterSpec[]>([
      { from: "*@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("applies domain-scope pending actions against *@domain mail", async () => {
    const store = createInMemoryStore();
    await store.domains.put(
      domainBuilder("ads.com", {
        trustStatus: "blocked",
        pendingActions: ["create_filter", "delete"],
      }),
    );
    const gmail = new MockGmailClient([msgFrom("promo@ads.com"), msgFrom("sale@ads.com")]);

    const result = await enforce(gmail, store, { now: NOW });

    expect(gmail.senderQueries).toContain("*@ads.com");
    expect(result.messagesTrashed).toBe(2);
    const domain = await store.domains.get(domainBuilder("ads.com").id);
    expect(domain?.pendingActions).toEqual([]);
  });

  it("rescues a spam-marked trusted sender and zeroes the marker", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("friend@good.com", { trustStatus: "trusted", spamMarkedCount: 3 }),
    );
    const gmail = new MockGmailClient([msgFrom("friend@good.com")]);

    const result = await enforce(gmail, store, { now: NOW });

    expect(gmail.batchModifyCalls[0]?.edit).toEqual({ removeLabelIds: ["SPAM", "TRASH"] });
    expect(result.messagesRescued).toBe(1);
    const sender = await store.senders.get(senderBuilder("friend@good.com").id);
    expect(sender?.spamMarkedCount).toBe(0);

    // Idempotent: a second run does not re-rescue.
    const second = await enforce(gmail, store, { now: NOW });
    expect(second.messagesRescued).toBe(0);
  });

  it("deletes a managed filter when its sender is no longer blocked", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("gone@x.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();

    // First run creates (and records as managed) the filter for the blocked sender.
    await enforce(gmail, store, { now: NOW });
    expect(gmail.createdFilters).toHaveLength(1);

    // Once the sender is no longer blocked, a follow-up run deletes its own filter.
    await store.senders.put(senderBuilder("gone@x.com", { trustStatus: "pending" }));
    const result = await enforce(gmail, store, { now: NOW + 1000 });

    expect(gmail.deletedFilterIds).toEqual(["filter-1"]);
    expect(result.filtersDeleted).toBe(1);
    expect(result.totalFilters).toBe(0);
  });

  it("never deletes a foreign filter that merely shares the block action shape (#29)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    // A filter the user built by hand in Gmail's own UI — same "Trash + skip inbox"
    // action as an app-created block filter, but never created through this app.
    gmail.seedFilters([
      {
        id: "hand-made",
        from: "oldjob@company.com",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);

    const result = await enforce(gmail, store, { now: NOW });

    expect(gmail.deletedFilterIds).toEqual([]);
    expect(result.filtersDeleted).toBe(0);
    expect(result.totalFilters).toBe(1);
  });

  it("does not create a duplicate filter when an untracked one already matches (#80)", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@a.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    // A filter with the exact desired shape, but never created through this app —
    // e.g. built by hand, or created before ownership tracking existed (#29).
    gmail.seedFilters([
      {
        id: "untracked",
        from: "spam@a.com",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);

    const result = await enforce(gmail, store, { now: NOW });

    expect(gmail.createdFilters).toEqual([]);
    expect(result.filtersCreated).toBe(0);
    expect(result.totalFilters).toBe(1);
  });

  it("counts an unsubscribe request without an unsubscribe transport", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("news@promo.com", {
        trustStatus: "blocked",
        hasListUnsubscribe: true,
        pendingActions: ["unsubscribe", "create_filter"],
      }),
    );
    const gmail = new MockGmailClient([msgFrom("news@promo.com")]);

    const result = await enforce(gmail, store, { now: NOW });

    expect(result.unsubscribeRequested).toBe(1);
  });

  it("surfaces the soft cap without crashing", async () => {
    const store = createInMemoryStore();
    for (const email of ["a@a.com", "b@b.com", "c@c.com"]) {
      await store.senders.put(senderBuilder(email, { trustStatus: "blocked" }));
    }
    const gmail = new MockGmailClient();

    const result = await enforce(gmail, store, { now: NOW, compile: { softCap: 1 } });

    expect(result.capReached).toBe(true);
    expect(result.skippedAtCap).toBe(2);
    expect(gmail.createdFilters).toHaveLength(1);
  });

  it("is best-effort — a failing filter create is recorded, not thrown", async () => {
    class FlakyClient extends MockGmailClient {
      override createFilter(): never {
        throw new Error("boom");
      }
    }
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("x@y.com", { trustStatus: "blocked" }));
    const gmail = new FlakyClient();

    const result = await enforce(gmail, store, { now: NOW });

    expect(result.filtersCreated).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toBe("boom");
  });

  it("keeps the last known-good totalFilters when listFilters() fails", async () => {
    class FlakyListClient extends MockGmailClient {
      override listFilters(): never {
        throw new Error("503");
      }
    }
    const store = createInMemoryStore();
    await store.filterSync.put({
      key: FILTER_SYNC_KEY,
      lastSyncAt: NOW - 1000,
      totalFilters: 7,
      managedFilterIds: [],
    });
    await store.senders.put(senderBuilder("x@y.com", { trustStatus: "blocked" }));
    const gmail = new FlakyListClient();

    const result = await enforce(gmail, store, { now: NOW });

    expect(result.totalFilters).toBe(7);
    expect(result.failures).toEqual([{ subject: "filters", error: "503" }]);
    const sync = await store.filterSync.get();
    expect(sync?.totalFilters).toBe(7);
  });

  it("does not clear pendingActions when matching messages exceed the fetch ceiling", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("spam@a.com", {
        trustStatus: "blocked",
        pendingActions: ["create_filter", "archive"],
      }),
    );
    const gmail = new MockGmailClient([
      msgFrom("spam@a.com"),
      msgFrom("spam@a.com"),
      msgFrom("spam@a.com"),
    ]);

    const result = await enforce(gmail, store, { now: NOW, messageIdCeiling: 2 });

    // Only the first 2 (of 3) matching messages were fetched and archived...
    expect(gmail.batchModifyCalls[0]?.ids).toHaveLength(2);
    expect(result.messagesArchived).toBe(2);
    // ...but pendingActions is retained so a follow-up run can pick up the rest.
    const sender = await store.senders.get(senderBuilder("spam@a.com").id);
    expect(sender?.pendingActions).toEqual(["create_filter", "archive"]);
    expect(result.failures).toEqual([
      {
        subject: "spam@a.com",
        error: "more than 2 matching messages; pendingActions retained for a follow-up run",
      },
    ]);
  });

  it("does not zero spamMarkedCount when spam-marked messages exceed the fetch ceiling", async () => {
    const store = createInMemoryStore();
    await store.senders.put(
      senderBuilder("friend@good.com", { trustStatus: "trusted", spamMarkedCount: 3 }),
    );
    const gmail = new MockGmailClient([
      msgFrom("friend@good.com"),
      msgFrom("friend@good.com"),
      msgFrom("friend@good.com"),
    ]);

    const result = await enforce(gmail, store, { now: NOW, messageIdCeiling: 2 });

    expect(result.messagesRescued).toBe(2);
    const sender = await store.senders.get(senderBuilder("friend@good.com").id);
    expect(sender?.spamMarkedCount).toBe(3);
    expect(result.failures).toEqual([
      {
        subject: "friend@good.com",
        error: "more than 2 spam-marked messages; spamMarkedCount retained for a follow-up run",
      },
    ]);
  });
});
