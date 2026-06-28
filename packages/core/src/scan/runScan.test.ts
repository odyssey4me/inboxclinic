import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import { inboxFromSender, messageMetaBuilder } from "../testing/builders";
import { createInMemoryStore } from "../testing/inMemoryStore";
import { MockGmailClient } from "../testing/MockGmailClient";
import { buildScanQuery, runScan } from "./runScan";

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

    expect(result).toEqual({ messageCount: 3, senderCount: 3, domainCount: 2 });
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
});
