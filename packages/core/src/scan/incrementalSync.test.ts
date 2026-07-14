// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { incrementalSync } from "./incrementalSync";
import { keyFor } from "../keys";
import { createInMemoryStore, messageMetaBuilder, MockGmailClient } from "../testing";
import type { HistoryRecord, MessageMeta } from "../ports/GmailClient";
import type { Profile, Store } from "../store";

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

  it("keeps a domain's batch size consistent when a delta touches only one member (#68)", async () => {
    // Seed 5 distinct pending senders sharing a domain, all in one full sync.
    const client = new MockGmailClient(
      [
        msg("p1", "one@promo.com"),
        msg("p2", "two@promo.com"),
        msg("p3", "three@promo.com"),
        msg("p4", "four@promo.com"),
        msg("p5", "five@promo.com"),
      ],
      "owner@gmail.com",
    );
    client.setLatestHistoryId("100");
    const store = createInMemoryStore();
    await incrementalSync(client, store, { now: NOW });

    // Sanity: the initial full sync already agrees on batchSize 5 for the domain.
    const initialSizes = await Promise.all(
      ["one", "two", "three", "four", "five"].map(
        async (n) => (await store.prompts.get(keyFor(`${n}@promo.com`)))?.batchSize,
      ),
    );
    expect(initialSizes).toEqual([5, 5, 5, 5, 5]);

    // A single new message from just one domain-mate should not desync the batch size —
    // every prompt in the domain must still report the same 5-member batch.
    client.addInboxMessages([msg("p1b", "one@promo.com")]);
    client.seedHistory(
      [{ id: "150", messagesAdded: [{ message: { id: "p1b", threadId: "t-p1b" } }] }],
      "200",
    );
    await incrementalSync(client, store, { now: NOW });

    const sizesAfter = await Promise.all(
      ["one", "two", "three", "four", "five"].map(
        async (n) => (await store.prompts.get(keyFor(`${n}@promo.com`)))?.batchSize,
      ),
    );
    expect(sizesAfter).toEqual([5, 5, 5, 5, 5]);
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

  it("nets an add-then-delete within one window to zero, not -1", async () => {
    const { client, store } = await syncedFixture();

    client.addInboxMessages([msg("c1", "fresh@new.com")]);
    client.seedHistory(
      [
        {
          id: "150",
          messagesAdded: [{ message: { id: "c1", threadId: "t-c1", labelIds: ["INBOX"] } }],
          messagesDeleted: [{ message: { id: "c1", threadId: "t-c1" } }],
        },
      ],
      "210",
    );

    const result = await incrementalSync(client, store, { now: NOW });

    expect(result.messagesAdded).toBe(0);
    expect(result.messagesRemoved).toBe(0);
    const profile = await store.profile.get();
    expect(profile?.messageCount).toBe(2);
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

describe("incrementalSync — concurrency & partial failure (#48)", () => {
  it("does not double-count a sync interrupted before the final profile.put", async () => {
    const { client, store } = await syncedFixture();
    const before = await store.senders.get(keyFor("jane@acme.com"));

    client.addInboxMessages([msg("a2", "jane@acme.com")]);
    client.seedHistory(
      [{ id: "150", messagesAdded: [{ message: { id: "a2", threadId: "t-a2" } }] }],
      "200",
    );

    // Simulate the tab closing (or a write failing) right at the final commit: the
    // additive sender merge has already landed, but the last profile write hasn't.
    let putCount = 0;
    const flakyStore: Store = {
      ...store,
      profile: {
        get: () => store.profile.get(),
        put: async (value: Profile) => {
          putCount += 1;
          if (putCount === 2) throw new Error("interrupted");
          await store.profile.put(value);
        },
      },
      exportAll: store.exportAll.bind(store),
      importAll: store.importAll.bind(store),
      wipeAll: store.wipeAll.bind(store),
    };

    await expect(incrementalSync(client, flakyStore, { now: NOW })).rejects.toThrow("interrupted");

    // The claim write already advanced the marker past this batch's historyId — a real
    // Gmail `listHistory` from an already-delivered marker returns no further records
    // for it, so the retry must not re-apply the same delta.
    client.seedHistory([], "200");
    const retry = await incrementalSync(client, store, { now: NOW });

    expect(retry.mode).toBe("incremental");
    expect(retry.messagesAdded).toBe(0);
    const after = await store.senders.get(keyFor("jane@acme.com"));
    expect(after?.totalEmails).toBe((before?.totalEmails ?? 0) + 1);
  });

  it("collapses concurrent calls for the same store into a single run", async () => {
    const { client, store } = await syncedFixture();

    client.addInboxMessages([msg("c1", "fresh@new.com")]);
    client.seedHistory(
      [{ id: "150", messagesAdded: [{ message: { id: "c1", threadId: "t-c1" } }] }],
      "200",
    );

    const [first, second] = await Promise.all([
      incrementalSync(client, store, { now: NOW }),
      incrementalSync(client, store, { now: NOW }),
    ]);

    expect(second).toBe(first);
    expect(client.historyQueries).toEqual(["100"]); // a single listHistory call
    const sender = await store.senders.get(keyFor("fresh@new.com"));
    expect(sender?.totalEmails).toBe(1);
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
