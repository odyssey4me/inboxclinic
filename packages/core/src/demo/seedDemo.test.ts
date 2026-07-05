// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { analyticsSummary } from "../analytics/summary";
import { learnPriorDecisions } from "../decisions/learnPriorDecisions";
import { keyFor } from "../keys";
import { runScan } from "../scan/runScan";
import { DEMO_ACCOUNT_EMAIL, DEMO_HISTORY_ID, demoInbox } from "./demoData";
import { InMemoryGmailClient } from "./inMemoryGmail";
import { createInMemoryStore } from "./inMemoryStore";
import { createDemoEnvironment, seedDemoStore } from "./seedDemo";

const NOW = Date.UTC(2026, 6, 5); // 2026-07-05, fixed for determinism

describe("demo environment", () => {
  it("builds an inbox whose message count matches the curated specs", () => {
    const inbox = demoInbox(NOW);
    // 16 inbox senders + 3 Spam/Trash-only senders (15 msgs) for the learning-scan demo.
    expect(inbox.length).toBe(131);
    // Every message is deterministic and dated at or before `now`.
    expect(inbox.every((m) => m.internalDate <= NOW)).toBe(true);
    expect(new Set(inbox.map((m) => m.id)).size).toBe(inbox.length);
  });

  it("seeds a populated store spanning every category with a trust/block mix", async () => {
    const { store, gmail } = await createDemoEnvironment({ now: NOW });

    const senders = await store.senders.query({});
    expect(senders.length).toBe(16);
    expect(gmail.getAccountEmail && (await gmail.getAccountEmail())).toBe(DEMO_ACCOUNT_EMAIL);

    // All four M1 categories are represented.
    const categories = new Set(senders.map((s) => s.category));
    for (const c of ["personal", "transactional", "promotional", "other"]) {
      expect(categories.has(c as (typeof senders)[number]["category"])).toBe(true);
    }

    // Pre-decisions applied: two trusted, two blocked (rest pending).
    const byId = new Map(senders.map((s) => [s.id, s]));
    expect(byId.get(keyFor("jane.cooper@gmail.com"))?.trustStatus).toBe("trusted");
    expect(byId.get(keyFor("notifications@github.com"))?.trustStatus).toBe("trusted");
    expect(byId.get(keyFor("deals@retailco.com"))?.trustStatus).toBe("blocked");
    expect(byId.get(keyFor("security@paypa1-alert.com"))?.trustStatus).toBe("blocked");
    expect(senders.filter((s) => s.trustStatus === "pending").length).toBeGreaterThan(5);

    // A shared domain drives the workflow batch-offer.
    const retailco = await store.domains.get(keyFor("retailco.com"));
    expect(retailco?.senderCount).toBe(2);
  });

  it("leaves open prompts for the undecided senders", async () => {
    const { store } = await createDemoEnvironment({ now: NOW });
    const open = (await store.prompts.query({})).filter((p) => p.resolvedAt === null);
    expect(open.length).toBeGreaterThan(5);
  });

  it("primes the history marker so demo sync is a no-op", async () => {
    const { store } = await createDemoEnvironment({ now: NOW });
    const profile = await store.profile.get();
    expect(profile?.lastHistoryId).toBe(DEMO_HISTORY_ID);
    expect(profile?.onboardingComplete).toBe(true);
  });

  it("back-fills analytics so the summary has health and recent activity", async () => {
    const { store } = await createDemoEnvironment({ now: NOW });
    const summary = await analyticsSummary(store, { now: NOW });
    expect(summary.inboxHealthScore).toBeGreaterThan(0);
    expect(summary.trend.length).toBeGreaterThan(0);
    expect(summary.window.emailsBlocked).toBeGreaterThan(0);
  });

  it("is idempotent under a re-scan: preserves prior decisions", async () => {
    const { store, gmail } = await createDemoEnvironment({ now: NOW });
    const before = (await store.senders.query({})).length;

    await runScan(gmail, store, { now: NOW });

    expect((await store.senders.query({})).length).toBe(before);
    const jane = await store.senders.get(keyFor("jane.cooper@gmail.com"));
    expect(jane?.trustStatus).toBe("trusted");
  });

  it("exposes learnable prior decisions from Spam/Trash (unread-binned only)", async () => {
    const { store, gmail } = await createDemoEnvironment({ now: NOW });
    const labels = (await learnPriorDecisions(gmail, store, { now: NOW })).map((s) => s.label);
    expect(labels).toContain("wins@megacasino.example"); // spam-marked
    expect(labels).toContain("blast@flashdeals.example"); // unread when binned
    expect(labels).not.toContain("receipts@cornershop.example"); // read then binned — not a signal
  });

  it("seedDemoStore populates a caller-provided store + gmail client", async () => {
    const gmail = new InMemoryGmailClient([], DEMO_ACCOUNT_EMAIL);
    const store = createInMemoryStore();
    await seedDemoStore(store, gmail, { now: NOW });
    expect((await store.senders.query({})).length).toBe(16);
  });
});
