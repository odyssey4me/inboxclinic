// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

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
      { id: "f1", from: "spam@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      { id: "f2", from: "*@promo.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      // A non-block filter (e.g. star/label) is ignored.
      { id: "f3", from: "friend@y.com", addLabelIds: ["STARRED"], removeLabelIds: [] },
    ]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out.map((s) => s.label).sort()).toEqual(["promo.com", "spam@x.com"]);
    expect(out.every((s) => s.reason === "filter")).toBe(true);
    expect(out.find((s) => s.label === "promo.com")?.scope).toBe("domain");
  });

  it("suggests blocks from spam-marked mail", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    gmail.seedInbox([msg("1", "junk@spam.com", ["SPAM", "UNREAD"])]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "junk@spam.com", reason: "spam" });
  });

  it("suggests binned mail only when it was unread (read-then-deleted is not a signal)", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    gmail.seedInbox([
      // Unread-binned → block signal.
      msg("1", "blast@ads.com", ["TRASH", "UNREAD"]),
      msg("2", "blast@ads.com", ["TRASH", "UNREAD"]),
      // Read-then-deleted → normal triage, ignored.
      msg("3", "digest@news.com", ["TRASH"]),
    ]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out.map((s) => s.label)).toEqual(["blast@ads.com"]);
    expect(out[0]?.reason).toBe("trash");
  });

  it("never re-suggests a subject already decided", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("spam@x.com", { trustStatus: "blocked" }));
    const gmail = new MockGmailClient();
    gmail.seedFilters([
      { id: "f1", from: "spam@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);

    expect(await learnPriorDecisions(gmail, store, { now: NOW })).toHaveLength(0);
  });

  it("dedupes across sources, keeping the strongest reason", async () => {
    const store = createInMemoryStore();
    const gmail = new MockGmailClient();
    // Same subject appears as both a filter and spam-marked mail.
    gmail.seedFilters([
      { id: "f1", from: "deals@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    gmail.seedInbox([msg("1", "deals@x.com", ["SPAM", "UNREAD"])]);

    const out = await learnPriorDecisions(gmail, store, { now: NOW });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subjectId: keyFor("deals@x.com"), reason: "filter" });
  });
});
