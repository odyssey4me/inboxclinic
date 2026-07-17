// SPDX-License-Identifier: Apache-2.0
import {
  keyFor,
  type DailyAnalytics,
  type Domain,
  type FilterSyncState,
  type MonthlyAnalytics,
  type Profile,
  type Prompt,
  type Sender,
  type Setting,
} from "@inboxclinic/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDexieStore, DexieStore } from "./DexieStore";

let dbSeq = 0;
let store: DexieStore;

function senderFixture(email: string, overrides: Partial<Sender> = {}): Sender {
  return {
    id: keyFor(email),
    email,
    domain: email.slice(email.indexOf("@") + 1),
    displayName: null,
    category: "personal",
    trustStatus: "pending",
    totalEmails: 1,
    hasListUnsubscribe: false,
    hasListId: false,
    firstSeenAt: 1,
    lastSeenAt: 1,
    updatedAt: 1,
    readRate: 1,
    starredCount: 0,
    spamMarkedCount: 0,
    deletedUnreadCount: 0,
    coveredByBlockFilter: false,
    replyCount: 0,
    inContacts: false,
    frequency: "rare",
    recencyBuckets: { d30: 0, d90: 0, d180: 0, older: 1 },
    auth: { spf: false, dkim: false, dmarc: false, spoofed: false },
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
    ...overrides,
  };
}

beforeEach(() => {
  dbSeq += 1;
  store = new DexieStore(`test-db-${dbSeq}`);
});

afterEach(() => {
  store.close();
});

describe("DexieStore senders/domains repos", () => {
  it("round-trips a sender by its keyFor id", async () => {
    const sender = senderFixture("jane@acme.com");
    await store.senders.put(sender);

    expect(await store.senders.get(keyFor("jane@acme.com"))).toEqual(sender);
  });

  it("bulkPuts and queries senders by an indexed field", async () => {
    await store.senders.bulkPut([
      senderFixture("a@acme.com", { domain: "acme.com" }),
      senderFixture("b@acme.com", { domain: "acme.com" }),
      senderFixture("c@other.com", { domain: "other.com" }),
    ]);

    const acme = await store.senders.query({ domain: "acme.com" });
    expect(acme.map((s) => s.email).sort()).toEqual(["a@acme.com", "b@acme.com"]);

    const all = await store.senders.query({});
    expect(all).toHaveLength(3);
  });

  it("queries senders by a non-indexed field, falling back to a full scan", async () => {
    await store.senders.bulkPut([
      senderFixture("a@acme.com", { displayName: "Ann" }),
      senderFixture("b@acme.com", { displayName: "Bea" }),
    ]);

    const matches = await store.senders.query({ displayName: "Bea" });
    expect(matches.map((s) => s.email)).toEqual(["b@acme.com"]);
  });

  it("queries senders by an indexed field combined with a non-indexed field", async () => {
    await store.senders.bulkPut([
      senderFixture("a@acme.com", { domain: "acme.com", displayName: "Ann" }),
      senderFixture("b@acme.com", { domain: "acme.com", displayName: "Bea" }),
      senderFixture("c@other.com", { domain: "other.com", displayName: "Ann" }),
    ]);

    const matches = await store.senders.query({ domain: "acme.com", displayName: "Ann" });
    expect(matches.map((s) => s.email)).toEqual(["a@acme.com"]);
  });

  it("deletes a sender", async () => {
    const sender = senderFixture("gone@acme.com");
    await store.senders.put(sender);
    await store.senders.delete(sender.id);

    expect(await store.senders.get(sender.id)).toBeUndefined();
  });

  it("round-trips a domain", async () => {
    const domain: Domain = {
      id: keyFor("acme.com"),
      domain: "acme.com",
      trustStatus: "pending",
      senderCount: 2,
      totalEmails: 5,
      exceptionAddresses: [],
      updatedAt: 1,
      trustDecidedAt: null,
      decisionScope: null,
      decisionContext: null,
      pendingActions: [],
    };
    await store.domains.put(domain);

    expect(await store.domains.get(keyFor("acme.com"))).toEqual(domain);
  });
});

describe("DexieStore profile (singleton)", () => {
  const profile: Profile = {
    googleEmail: "owner@gmail.com",
    onboardingComplete: false,
    lastHistoryId: null,
    senderCount: 0,
    domainCount: 0,
    messageCount: 0,
    lastScanAt: null,
    privacy: { contributeToAggregate: true },
  };

  it("stores and reads back the single profile record", async () => {
    await store.profile.put(profile);
    expect(await store.profile.get()).toEqual(profile);
  });

  it("keeps only one profile record even if the account email changes", async () => {
    await store.profile.put(profile);
    await store.profile.put({ ...profile, googleEmail: "renamed@gmail.com" });

    const current = await store.profile.get();
    expect(current?.googleEmail).toBe("renamed@gmail.com");
  });
});

describe("DexieStore export / wipe", () => {
  it("exports every store as a JSON blob and wipeAll clears them", async () => {
    await store.senders.put(senderFixture("jane@acme.com"));
    await store.profile.put({
      googleEmail: "owner@gmail.com",
      onboardingComplete: true,
      lastHistoryId: null,
      senderCount: 1,
      domainCount: 1,
      messageCount: 1,
      lastScanAt: 1,
      privacy: { contributeToAggregate: true },
    });

    const blob = await store.exportAll();
    const dump = JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown[]>;
    expect(dump.senders).toHaveLength(1);
    expect(dump.profile).toHaveLength(1);

    await store.wipeAll();
    expect(await store.senders.query({})).toHaveLength(0);
    expect(await store.profile.get()).toBeUndefined();
  });

  it("restores state from an exported blob via importAll", async () => {
    await store.senders.bulkPut([senderFixture("a@acme.com"), senderFixture("b@acme.com")]);
    const blob = await store.exportAll();

    await store.wipeAll();
    await store.importAll(blob);

    expect(await store.senders.query({})).toHaveLength(2);
  });
});

describe("DexieStore prompts (priority-ordered)", () => {
  function promptFixture(id: string, priorityScore: number): Prompt {
    return {
      id,
      senderId: keyFor(`${id}@acme.com`),
      priorityScore,
      components: { impact: 0, confidence: 0, batch: 0, alignment: 0 },
      batchGroupId: null,
      batchSize: 1,
      createdAt: 0,
      expiresAt: 0,
      resolvedAt: null,
      deferredAt: null,
    };
  }

  it("returns prompts highest-priority first, bounded by the limit", async () => {
    await store.prompts.bulkPut([
      promptFixture("low", 10),
      promptFixture("high", 90),
      promptFixture("mid", 50),
    ]);

    const top = await store.prompts.byPriority(2);
    expect(top.map((p) => p.id)).toEqual(["high", "mid"]);
  });
});

describe("DexieStore analytics", () => {
  const day: DailyAnalytics = {
    date: "2026-06-28",
    newSenders: 3,
    decisionsMade: 2,
    sendersBlocked: 1,
    sendersTrusted: 1,
    emailsBlocked: 40,
    emailsRescued: 0,
  };
  const month: MonthlyAnalytics = {
    month: "2026-06",
    newSenders: 3,
    decisionsMade: 2,
    sendersBlocked: 1,
    sendersTrusted: 1,
    emailsBlocked: 40,
    emailsRescued: 0,
    inboxHealthScore: 72,
    estimatedTimeSaved: 200,
    achievements: ["first-block"],
  };

  it("round-trips daily and monthly analytics by their date keys", async () => {
    await store.analytics.putDay(day);
    await store.analytics.putMonth(month);

    expect(await store.analytics.day("2026-06-28")).toEqual(day);
    expect(await store.analytics.month("2026-06")).toEqual(month);
    expect(await store.analytics.day("2000-01-01")).toBeUndefined();
  });

  it("returns the most recent days first, bounded by the limit", async () => {
    await store.analytics.putDay({ ...day, date: "2026-06-26" });
    await store.analytics.putDay({ ...day, date: "2026-06-27" });
    await store.analytics.putDay({ ...day, date: "2026-06-28" });

    const recent = await store.analytics.recentDays(2);
    expect(recent.map((d) => d.date)).toEqual(["2026-06-28", "2026-06-27"]);
  });
});

describe("DexieStore filterSync (singleton) and settings", () => {
  it("stores and reads back the singleton filter-sync state", async () => {
    const state: FilterSyncState = {
      key: "singleton",
      lastSyncAt: 123,
      totalFilters: 7,
      managedFilterIds: ["filter-1"],
    };
    await store.filterSync.put(state);

    expect(await store.filterSync.get()).toEqual(state);
  });

  it("round-trips a setting keyed by its key", async () => {
    const setting: Setting = { key: "theme", value: "dark" };
    await store.settings.put(setting);

    expect(await store.settings.get("theme")).toEqual(setting);
  });
});

describe("createDexieStore", () => {
  it("returns a working Store backed by Dexie", async () => {
    const built = createDexieStore(`factory-db-${dbSeq}`);
    await built.senders.put(senderFixture("factory@acme.com"));

    expect(await built.senders.get(keyFor("factory@acme.com"))).toBeDefined();
  });
});
