// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { incrementalSync } from "./incrementalSync";
import { keyFor } from "../keys";
import { createInMemoryStore, messageMetaBuilder, MockGmailClient } from "../testing";
import type { HistoryRecord, MessageMeta } from "../ports/GmailClient";

const NOW = Date.UTC(2026, 5, 28);

/** A message with explicit id/sender so history records can reference it precisely. */
function msg(id: string, from: string): MessageMeta {
  return messageMetaBuilder({ id, headers: { from }, internalDate: NOW, labelIds: ["INBOX"] });
}

/** Seed the inbox, run a first (full) sync, and return the synced fixtures. */
async function syncedFixture() {
  const client = new MockGmailClient(
    [msg("a1", "jane@acme.com"), msg("b1", "news@promo.com")],
    "owner@gmail.com",
  );
  client.setLatestHistoryId("100");
  const store = createInMemoryStore();
  const first = await incrementalSync(client, store, { now: NOW });
  return { client, store, first };
}

describe("incrementalSync — first run", () => {
  it("falls back to a full scan and seeds the historyId marker", async () => {
    const { client, store, first } = await syncedFixture();

    expect(first.mode).toBe("full");
    expect(first.rescanned).toBe(false);
    expect(first.messagesAdded).toBe(2);
    expect(first.sendersAdded).toBe(2);
    expect(first.historyId).toBe("100");
    // No history call on the first run — there was no marker to sync from.
    expect(client.historyQueries).toEqual([]);

    const profile = await store.profile.get();
    expect(profile?.lastHistoryId).toBe("100");
    expect((await store.senders.query({})).map((s) => s.email).sort()).toEqual([
      "jane@acme.com",
      "news@promo.com",
    ]);
  });
});

describe("incrementalSync — added delta", () => {
  it("adds a new sender, generates its prompt, and advances the marker", async () => {
    const { client, store } = await syncedFixture();

    client.addInboxMessages([msg("c1", "fresh@new.com")]);
    const records: HistoryRecord[] = [
      {
        id: "150",
        messagesAdded: [{ message: { id: "c1", threadId: "t-c1", labelIds: ["INBOX"] } }],
      },
    ];
    client.seedHistory(records, "200");

    const result = await incrementalSync(client, store, { now: NOW });

    expect(result.mode).toBe("incremental");
    expect(result.messagesAdded).toBe(1);
    expect(result.sendersAdded).toBe(1);
    expect(result.historyId).toBe("200");
    expect(client.historyQueries).toEqual(["100"]);

    expect(await store.senders.get(keyFor("fresh@new.com"))).toMatchObject({
      email: "fresh@new.com",
      trustStatus: "pending",
      totalEmails: 1,
    });
    expect(await store.prompts.get(keyFor("fresh@new.com"))).toBeDefined();
    const profile = await store.profile.get();
    expect(profile?.lastHistoryId).toBe("200");
    expect(profile?.messageCount).toBe(3);
  });

  it("merges repeat messages into an existing sender's counts", async () => {
    const { client, store } = await syncedFixture();
    const before = await store.senders.get(keyFor("jane@acme.com"));

    client.addInboxMessages([msg("a2", "jane@acme.com")]);
    client.seedHistory(
      [{ id: "150", messagesAdded: [{ message: { id: "a2", threadId: "t-a2" } }] }],
      "200",
    );

    const result = await incrementalSync(client, store, { now: NOW });

    expect(result.sendersAdded).toBe(0);
    expect(result.sendersUpdated).toBe(1);
    const after = await store.senders.get(keyFor("jane@acme.com"));
    expect(after?.totalEmails).toBe((before?.totalEmails ?? 0) + 1);
  });

  it("ages carried-over recency buckets forward on each repeated sync (#67)", async () => {
    const { client, store } = await syncedFixture();
    const DAY = 24 * 60 * 60 * 1000;

    // jane's one message from the first sync is fresh (d30:1) as of NOW.
    const afterFirst = await store.senders.get(keyFor("jane@acme.com"));
    expect(afterFirst?.recencyBuckets).toEqual({ d30: 1, d90: 0, d180: 0, older: 0 });

    // 40 days later, jane sends again. Her first message is now >30 days old and should
    // have aged out of `d30` — not still be counted as recent.
    const secondNow = NOW + 40 * DAY;
    client.addInboxMessages([
      messageMetaBuilder({
        id: "a2",
        headers: { from: "jane@acme.com" },
        internalDate: secondNow,
        labelIds: ["INBOX"],
      }),
    ]);
    client.seedHistory(
      [{ id: "150", messagesAdded: [{ message: { id: "a2", threadId: "t-a2" } }] }],
      "200",
    );
    await incrementalSync(client, store, { now: secondNow });

    const afterSecond = await store.senders.get(keyFor("jane@acme.com"));
    expect(afterSecond?.totalEmails).toBe(2);
    expect(afterSecond?.recencyBuckets).toEqual({ d30: 1, d90: 1, d180: 0, older: 0 });
    // Buckets stay a true partition of the sender's messages, not an unbounded d30.
    const b = afterSecond!.recencyBuckets;
    expect(b.d30 + b.d90 + b.d180 + b.older).toBe(afterSecond!.totalEmails);
  });
});

describe("incrementalSync — removed delta", () => {
  it("decrements the mailbox message count and advances the marker", async () => {
    const { client, store } = await syncedFixture();

    client.seedHistory(
      [{ id: "150", messagesDeleted: [{ message: { id: "b1", threadId: "t-b1" } }] }],
      "210",
    );

    const result = await incrementalSync(client, store, { now: NOW });

    expect(result.messagesRemoved).toBe(1);
    expect(result.historyId).toBe("210");
    const profile = await store.profile.get();
    expect(profile?.messageCount).toBe(1);
    expect(profile?.lastHistoryId).toBe("210");
  });
});

describe("incrementalSync — label delta", () => {
  it("applies a SPAM signal delta to the affected sender", async () => {
    const { client, store } = await syncedFixture();
    expect((await store.senders.get(keyFor("jane@acme.com")))?.spamMarkedCount).toBe(0);

    client.seedHistory(
      [
        {
          id: "150",
          labelsAdded: [{ message: { id: "a1", threadId: "t-a1" }, labelIds: ["SPAM"] }],
        },
      ],
      "220",
    );

    const result = await incrementalSync(client, store, { now: NOW });

    expect(result.labelChanges).toBe(1);
    expect((await store.senders.get(keyFor("jane@acme.com")))?.spamMarkedCount).toBe(1);
  });
});

describe("incrementalSync — stale historyId", () => {
  it("transparently rescans and reseeds the marker on a 404", async () => {
    const { client, store } = await syncedFixture();
    client.setStaleHistory(true);
    client.setLatestHistoryId("999");

    const result = await incrementalSync(client, store, { now: NOW });

    expect(result.mode).toBe("full");
    expect(result.rescanned).toBe(true);
    expect(result.historyId).toBe("999");
    expect(client.historyQueries).toEqual(["100"]); // tried once, then fell back
    const profile = await store.profile.get();
    expect(profile?.lastHistoryId).toBe("999");
  });
});

describe("incrementalSync — filter reconciliation", () => {
  it("does not create duplicate filters on re-sync", async () => {
    const { client, store } = await syncedFixture();

    // The user blocks a sender out-of-band; its native filter is created on next sync.
    const blocked = await store.senders.get(keyFor("news@promo.com"));
    await store.senders.put({ ...blocked!, trustStatus: "blocked" });

    client.seedHistory([], "300");
    const firstSync = await incrementalSync(client, store, { now: NOW });
    expect(firstSync.filtersCreated).toBe(1);
    expect(client.createdFilters).toHaveLength(1);

    client.seedHistory([], "301");
    const secondSync = await incrementalSync(client, store, { now: NOW });
    expect(secondSync.filtersCreated).toBe(0);
    // Idempotent: still exactly one created filter overall.
    expect(client.createdFilters).toHaveLength(1);
  });
});
