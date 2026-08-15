// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { keyFor } from "../keys";
import type { MessageMeta } from "../ports/GmailClient";
import { createInMemoryStore, senderBuilder, MockGmailClient } from "../testing";
import { learnPriorDecisions } from "./learnPriorDecisions";

const NOW = Date.UTC(2026, 6, 5);

function msg(id: string, from: string, labelIds: string[]): MessageMeta {
  return { id, threadId: `t-${id}`, labelIds, internalDate: NOW, headers: { from } };
}

describe("learnPriorDecisions", () => {
  it("suggests blocks from block-shaped existing filters (address + domain)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "f1", from: "spam@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      { id: "f2", from: "*@promo.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      // A non-block filter (e.g. star/label) is ignored.
      { id: "f3", from: "friend@y.test", addLabelIds: ["STARRED"], removeLabelIds: [] },
    ]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out.map((s) => s.label).sort()).toEqual(["promo.test", "spam@x.test"]);
    expect(out.every((s) => s.reason === "filter")).toBe(true);
    expect(out.find((s) => s.label === "promo.test")?.scope).toBe("domain");
  });

  it("suggests blocks from spam-marked mail", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    gmail.seedInbox([msg("1", "junk@spam.test", ["SPAM", "UNREAD"])]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "junk@spam.test", reason: "spam" });
  });

  it("suggests binned mail only when it was unread (read-then-deleted is not a signal)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    gmail.seedInbox([
      // Unread-binned → block signal.
      msg("1", "blast@ads.test", ["TRASH", "UNREAD"]),
      msg("2", "blast@ads.test", ["TRASH", "UNREAD"]),
      // Read-then-deleted → normal triage, ignored.
      msg("3", "digest@news.test", ["TRASH"]),
    ]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out.map((s) => s.label)).toEqual(["blast@ads.test"]);
    expect(out[0]?.reason).toBe("trash");
  });

  it("persists a per-sender deleted-while-unread count as a scoring input", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    // An existing (undecided) sender that also has mail sitting in Trash, mostly unread.
    await store.senders.put(senderBuilder("blast@ads.test"));
    gmail.seedInbox([
      msg("1", "blast@ads.test", ["TRASH", "UNREAD"]),
      msg("2", "blast@ads.test", ["TRASH", "UNREAD"]),
      msg("3", "blast@ads.test", ["TRASH"]), // read-then-deleted — not part of the unread count
    ]);

    await learnPriorDecisions(gmail, store, { now: NOW });

    expect((await store.senders.get(keyFor("blast@ads.test")))?.deletedUnreadCount).toBe(2);
  });

  it("does not read a partially-matching filter as a prior block (#212)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      // Trashes only the mail from this sender whose subject matches — the user has not
      // decided to block the sender, and suggesting so would overstate their own rule.
      {
        id: "partial",
        from: "newsletter@x.test",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
        unmodelledCriteria: ["subject"],
      },
    ]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out.filter((s) => s.reason === "filter")).toEqual([]);
  });

  it("persists coveredByBlockFilter from existing block filters (address + domain)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    await store.senders.put(senderBuilder("a@x.test")); // covered by an address filter
    await store.senders.put(senderBuilder("b@promo.test")); // covered by *@promo.test
    await store.senders.put(senderBuilder("c@safe.test")); // not covered
    gmail.seedFilters([
      { id: "f1", from: "a@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      { id: "f2", from: "*@promo.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);

    await learnPriorDecisions(gmail, store, { now: NOW });

    expect((await store.senders.get(keyFor("a@x.test")))?.coveredByBlockFilter).toBe(true);
    expect((await store.senders.get(keyFor("b@promo.test")))?.coveredByBlockFilter).toBe(true);
    expect((await store.senders.get(keyFor("c@safe.test")))?.coveredByBlockFilter).toBe(false);
  });

  it("resets coveredByBlockFilter when the covering filter is gone", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    await store.senders.put(senderBuilder("a@x.test", { coveredByBlockFilter: true }));
    gmail.seedFilters([]); // no filters any more

    await learnPriorDecisions(gmail, store, { now: NOW });

    expect((await store.senders.get(keyFor("a@x.test")))?.coveredByBlockFilter).toBe(false);
  });

  it("preserves coveredByBlockFilter when the filter scan fails (no silent erase)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    await store.senders.put(senderBuilder("a@x.test", { coveredByBlockFilter: true }));
    vi.spyOn(gmail, "listFilters").mockRejectedValueOnce(new Error("rate limited"));

    await learnPriorDecisions(gmail, store, { now: NOW });

    // A transient failure must not wipe the previously-recorded signal.
    expect((await store.senders.get(keyFor("a@x.test")))?.coveredByBlockFilter).toBe(true);
  });

  it("never re-suggests a subject already decided", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@x.test", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "f1", from: "spam@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);

    expect(await learnPriorDecisions(gmail, store, { now: NOW })).toHaveLength(0);
  });

  it("dedupes across sources, keeping the strongest reason", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    // Same subject appears as both a filter and spam-marked mail.
    gmail.seedFilters([
      { id: "f1", from: "deals@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    gmail.seedInbox([msg("1", "deals@x.test", ["SPAM", "UNREAD"])]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subjectId: keyFor("deals@x.test"), reason: "filter" });
  });
});
