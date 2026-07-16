// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { applyDecision } from "../decisions/applyDecision";
import { keyFor } from "../keys";
import type { MessageMeta } from "../ports/GmailClient";
import {
  createInMemoryStore,
  inboxFromSender,
  messageMetaBuilder,
  MockGmailClient,
} from "../testing";
import { incrementalSync } from "./incrementalSync";
import { buildScanQuery, reseedHistoryMarker, runScan } from "./runScan";

/**
 * Wraps a `MockGmailClient` so `getMessageMeta` rejects for one id while
 * `listMessageIds` still lists it — simulating a message that moved/was deleted
 * between listing and fetch.
 */
class FlakyGmailClient extends MockGmailClient {
  constructor(
    messages: MessageMeta[],
    private readonly failingIds: ReadonlySet<string>,
  ) {
    super(messages);
  }

  override getMessageMeta(id: string): Promise<MessageMeta> {
    if (this.failingIds.has(id)) return Promise.reject(new Error("message not found"));
    return super.getMessageMeta(id);
  }
}

describe("buildScanQuery", () => {
  it("maps INBOX and the window into a bounded Gmail query", () => {
    expect(buildScanQuery(30, ["INBOX"])).toBe("in:inbox newer_than:30d");
  });

  it("maps non-system labels via label:", () => {
    expect(buildScanQuery(7, ["Receipts"])).toBe("label:receipts newer_than:7d");
  });
});

describe("runScan", () => {
  const NOW = 1_700_000_000_000;

  it("scans metadata, persists senders/domains, and updates the profile", async () => {
    const client = new MockGmailClient(
      [
        messageMetaBuilder({ headers: { from: "Jane <jane@acme.com>" } }),
        messageMetaBuilder({ headers: { from: "bob@acme.com" } }),
        messageMetaBuilder({
          headers: { from: "news@promo.com", listUnsubscribe: "<mailto:u@promo.com>" },
        }),
      ],
      "owner@gmail.com",
    );
    const store = createInMemoryStore();

    const result = await runScan(client, store, { now: NOW });

    expect(result).toEqual({ messageCount: 3, senderCount: 3, domainCount: 2, promptCount: 3 });
    expect(client.listQueries).toEqual(["in:inbox newer_than:30d"]);

    const senders = await store.senders.query({});
    expect(senders.map((s) => s.email).sort()).toEqual([
      "bob@acme.com",
      "jane@acme.com",
      "news@promo.com",
    ]);

    const promo = await store.senders.get(keyFor("news@promo.com"));
    expect(promo?.category).toBe("promotional");

    const profile = await store.profile.get();
    expect(profile).toMatchObject({
      googleEmail: "owner@gmail.com",
      senderCount: 3,
      domainCount: 2,
      messageCount: 3,
      lastScanAt: NOW,
      lastHistoryId: null,
      privacy: { contributeToAggregate: true },
    });
  });

  it("honours the window and label options when building the query", async () => {
    const client = new MockGmailClient([messageMetaBuilder({ headers: { from: "a@b.com" } })]);
    const store = createInMemoryStore();

    await runScan(client, store, { windowDays: 7, labelIds: ["INBOX", "IMPORTANT"], now: NOW });

    expect(client.listQueries).toEqual(["in:inbox label:important newer_than:7d"]);
  });

  it("caps the number of messages fetched", async () => {
    const client = new MockGmailClient(inboxFromSender("bulk@news.com", 50));
    const store = createInMemoryStore();

    const result = await runScan(client, store, { maxMessages: 5, now: NOW });

    expect(result.messageCount).toBe(5);
  });

  it("preserves the existing profile identity and privacy on rescan", async () => {
    const store = createInMemoryStore();
    await store.profile.put({
      googleEmail: "kept@gmail.com",
      onboardingComplete: true,
      lastHistoryId: "12345",
      senderCount: 0,
      domainCount: 0,
      messageCount: 0,
      lastScanAt: null,
      privacy: { contributeToAggregate: false },
    });
    const client = new MockGmailClient(
      [messageMetaBuilder({ headers: { from: "x@y.com" } })],
      "different@gmail.com",
    );

    await runScan(client, store, { now: NOW });

    const profile = await store.profile.get();
    expect(profile).toMatchObject({
      googleEmail: "kept@gmail.com",
      onboardingComplete: true,
      lastHistoryId: "12345",
      privacy: { contributeToAggregate: false },
      senderCount: 1,
    });
  });

  it("falls back to the client account email when no profile exists", async () => {
    const client = new MockGmailClient(
      [messageMetaBuilder({ headers: { from: "x@y.com" } })],
      "fromclient@gmail.com",
    );
    const store = createInMemoryStore();

    await runScan(client, store, { now: NOW });

    const profile = await store.profile.get();
    expect(profile?.googleEmail).toBe("fromclient@gmail.com");
  });

  it("generates and persists a prompt per undecided sender", async () => {
    const client = new MockGmailClient([
      messageMetaBuilder({ headers: { from: "jane@acme.com" } }),
      messageMetaBuilder({ headers: { from: "news@promo.com" } }),
    ]);
    const store = createInMemoryStore();

    const result = await runScan(client, store, { now: NOW });

    expect(result.promptCount).toBe(2);
    const prompts = await store.prompts.query({});
    expect(prompts).toHaveLength(2);
    const jane = await store.prompts.get(keyFor("jane@acme.com"));
    expect(jane).toMatchObject({
      senderId: keyFor("jane@acme.com"),
      createdAt: NOW,
      expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
      resolvedAt: null,
    });
  });

  it("skips a message that fails to fetch instead of aborting the whole scan", async () => {
    const ok = messageMetaBuilder({ headers: { from: "jane@acme.com" } });
    const flaky = messageMetaBuilder({ headers: { from: "bob@acme.com" } });
    const client = new FlakyGmailClient([ok, flaky], new Set([flaky.id]));
    const store = createInMemoryStore();

    const result = await runScan(client, store, { now: NOW });

    expect(result).toEqual({ messageCount: 1, senderCount: 1, domainCount: 1, promptCount: 1 });
    const senders = await store.senders.query({});
    expect(senders.map((s) => s.email)).toEqual(["jane@acme.com"]);
  });

  it("throws instead of reporting an empty scan when every message fails to fetch", async () => {
    const a = messageMetaBuilder({ headers: { from: "jane@acme.com" } });
    const b = messageMetaBuilder({ headers: { from: "bob@acme.com" } });
    const client = new FlakyGmailClient([a, b], new Set([a.id, b.id]));
    const store = createInMemoryStore();

    await expect(runScan(client, store, { now: NOW })).rejects.toThrow(
      "runScan: failed to fetch any message metadata",
    );
  });

  it("preserves prior decisions and skips prompts for decided senders on rescan", async () => {
    const client = new MockGmailClient([
      messageMetaBuilder({ headers: { from: "jane@acme.com" } }),
      messageMetaBuilder({ headers: { from: "news@promo.com" } }),
    ]);
    const store = createInMemoryStore();

    await runScan(client, store, { now: NOW });

    // The user blocks one sender; a later rescan must not re-prompt it.
    const blocked = await store.senders.get(keyFor("news@promo.com"));
    await store.senders.put({ ...blocked!, trustStatus: "blocked" });
    await store.prompts.delete(keyFor("news@promo.com"));

    const result = await runScan(client, store, { now: NOW + 1000 });

    expect(await store.senders.get(keyFor("news@promo.com"))).toMatchObject({
      trustStatus: "blocked",
    });
    expect(result.promptCount).toBe(1);
    expect(await store.prompts.get(keyFor("news@promo.com"))).toBeUndefined();
    expect(await store.prompts.get(keyFor("jane@acme.com"))).toBeDefined();
  });

  it("preserves a blocked sender's pendingActions across a rescan", async () => {
    const client = new MockGmailClient([
      messageMetaBuilder({ headers: { from: "news@promo.com" } }),
    ]);
    const store = createInMemoryStore();

    await runScan(client, store, { now: NOW });

    // Mirrors applyDecision's block bookkeeping (staged for M4 enforcement).
    const blocked = await store.senders.get(keyFor("news@promo.com"));
    await store.senders.put({
      ...blocked!,
      trustStatus: "blocked",
      trustDecidedAt: NOW,
      decisionScope: "address",
      pendingActions: ["create_filter", "archive"],
    });

    await runScan(client, store, { now: NOW + 1000 });

    expect(await store.senders.get(keyFor("news@promo.com"))).toMatchObject({
      trustStatus: "blocked",
      trustDecidedAt: NOW,
      decisionScope: "address",
      pendingActions: ["create_filter", "archive"],
    });
  });

  it("does not re-prompt a domain-decided sender's members on rescan (#123)", async () => {
    const client = new MockGmailClient([
      messageMetaBuilder({ headers: { from: "a@x.com" } }),
      messageMetaBuilder({ headers: { from: "b@x.com" } }),
    ]);
    const store = createInMemoryStore();

    await runScan(client, store, { now: NOW });
    // Block the whole domain — its members are now covered (effectively decided).
    await applyDecision(store, {
      subjectId: keyFor("x.com"),
      scope: "domain",
      decision: "block",
      actions: ["create_filter"],
      decidedVia: "dashboard",
      now: NOW,
    });

    // A later full rescan must not regenerate prompts for the domain-covered members.
    await runScan(client, store, { now: NOW + 1000 });

    const open = (await store.prompts.query({})).filter((p) => p.resolvedAt === null);
    expect(open).toHaveLength(0);
  });

  it("preserves a learn-populated deletedUnreadCount across a rescan", async () => {
    const client = new MockGmailClient([
      messageMetaBuilder({ headers: { from: "news@promo.com" } }),
    ]);
    const store = createInMemoryStore();

    await runScan(client, store, { now: NOW });

    // The learn pass (Trash scan) later records a deleted-unread count on this sender.
    const sender = await store.senders.get(keyFor("news@promo.com"));
    await store.senders.put({ ...sender!, deletedUnreadCount: 3 });

    // A full rescan rebuilds senders from the inbox (which can't see Trash) — it must not
    // wipe the learn-derived count.
    await runScan(client, store, { now: NOW + 1000 });

    expect((await store.senders.get(keyFor("news@promo.com")))?.deletedUnreadCount).toBe(3);
  });

  it("preserves a blocked domain's trustStatus and exceptionAddresses across a rescan", async () => {
    const client = new MockGmailClient([
      messageMetaBuilder({ headers: { from: "news@promo.com" } }),
      messageMetaBuilder({ headers: { from: "deals@promo.com" } }),
    ]);
    const store = createInMemoryStore();

    await runScan(client, store, { now: NOW });

    const domain = await store.domains.get(keyFor("promo.com"));
    await store.domains.put({
      ...domain!,
      trustStatus: "blocked",
      trustDecidedAt: NOW,
      decisionScope: "domain",
      pendingActions: ["create_filter", "archive"],
      exceptionAddresses: ["deals@promo.com"],
    });

    await runScan(client, store, { now: NOW + 1000 });

    expect(await store.domains.get(keyFor("promo.com"))).toMatchObject({
      trustStatus: "blocked",
      trustDecidedAt: NOW,
      decisionScope: "domain",
      pendingActions: ["create_filter", "archive"],
      exceptionAddresses: ["deals@promo.com"],
    });
  });
});

describe("reseedHistoryMarker", () => {
  const NOW = 1_700_000_000_000;

  it("advances lastHistoryId to the mailbox's current historyId", async () => {
    const client = new MockGmailClient([messageMetaBuilder({ headers: { from: "a@b.com" } })]);
    client.setLatestHistoryId("456");
    const store = createInMemoryStore();
    await store.profile.put({
      googleEmail: "owner@gmail.com",
      onboardingComplete: true,
      lastHistoryId: "123",
      senderCount: 0,
      domainCount: 0,
      messageCount: 0,
      lastScanAt: null,
      privacy: { contributeToAggregate: true },
    });

    await reseedHistoryMarker(client, store);

    expect((await store.profile.get())?.lastHistoryId).toBe("456");
  });

  it("is a no-op when no profile exists yet", async () => {
    const client = new MockGmailClient([messageMetaBuilder({ headers: { from: "a@b.com" } })]);
    client.setLatestHistoryId("456");
    const store = createInMemoryStore();

    await reseedHistoryMarker(client, store);

    expect(await store.profile.get()).toBeUndefined();
  });

  it("prevents a rescan follow by an incremental sync from double-counting (issue #47)", async () => {
    // Reproduces the reported bug: "Full rescan" (runScan) followed by the next
    // automatic sync (incrementalSync) must not replay history since a stale marker.
    const client = new MockGmailClient(
      [messageMetaBuilder({ headers: { from: "jane@acme.com" } })],
      "owner@gmail.com",
    );
    client.setLatestHistoryId("100");
    const store = createInMemoryStore();

    // First sync seeds the marker at historyId "100" (via incrementalSync's own
    // first-run path) — simulates the user having synced before rescanning.
    await incrementalSync(client, store, { now: NOW });
    expect((await store.profile.get())?.lastHistoryId).toBe("100");

    // Mailbox moves on; a "Full rescan" runs the bounded scan directly (bypassing
    // incrementalSync), then must reseed the marker itself.
    client.setLatestHistoryId("200");
    await runScan(client, store, { now: NOW + 1000 });
    await reseedHistoryMarker(client, store);
    expect((await store.profile.get())?.lastHistoryId).toBe("200");

    // The next automatic sync must not see a stale "100" marker.
    const next = await incrementalSync(client, store, { now: NOW + 2000 });
    expect(next.mode).toBe("incremental");
    expect(client.historyQueries).toEqual(["200"]);
  });
});
