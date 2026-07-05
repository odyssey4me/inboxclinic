// SPDX-License-Identifier: Apache-2.0
/**
 * Demo-mode environment builder (design-frontend.md — Demo mode).
 *
 * Assembles the in-memory client trio and seeds it with curated data so the whole
 * signed-in product is populated with no Google, no network, and nothing persisted
 * outside memory. The seed drives the *real* scan pipeline over the demo inbox, then
 * pre-decides a few senders and back-fills a fortnight of analytics so the Dashboard,
 * the trust workflow, and Analytics all look alive on first open.
 *
 * `now` is injectable so the fixtures and the resulting store are deterministic in tests.
 */

import { recordDailyAnalytics } from "../analytics/record";
import { applyDecision } from "../decisions/applyDecision";
import { keyFor } from "../keys";
import { runScan } from "../scan/runScan";
import type { Store } from "../store";
import {
  DEMO_ACCOUNT_EMAIL,
  DEMO_DECISIONS,
  DEMO_HISTORY_ID,
  DEMO_LEGACY_FILTERS,
  demoInbox,
} from "./demoData";
import { InMemoryBackupClient } from "./inMemoryBackup";
import { InMemoryGmailClient } from "./inMemoryGmail";
import { createInMemoryStore, InMemoryStore } from "./inMemoryStore";

export interface DemoEnvironment {
  gmail: InMemoryGmailClient;
  store: InMemoryStore;
  backup: InMemoryBackupClient;
}

export interface SeedDemoOptions {
  /** Injected clock; defaults to `Date.now()`. */
  now?: number;
}

const DAY_MS = 86_400_000;

/** Back-fill ~2 weeks of daily counters so the trend chart and 30-day summary populate. */
async function seedAnalyticsHistory(store: Store, now: number): Promise<void> {
  // A gently varying, deterministic pattern of blocked-email volume per day.
  const blockedPattern = [8, 5, 12, 3, 9, 14, 6, 11, 4, 7, 10, 2, 13, 5];
  for (let i = 0; i < blockedPattern.length; i += 1) {
    const daysAgo = i + 1;
    const when = now - daysAgo * DAY_MS;
    await recordDailyAnalytics(store, when, {
      emailsBlocked: blockedPattern[i] ?? 0,
      newSenders: daysAgo % 3 === 0 ? 2 : 0,
      decisionsMade: daysAgo % 4 === 0 ? 1 : 0,
      sendersBlocked: daysAgo % 4 === 0 ? 1 : 0,
    });
  }
}

/**
 * Populate `store` (and prime `gmail`'s history marker) with the curated demo data by
 * running the real scan over the demo inbox, pre-deciding a few senders, and seeding
 * analytics history. Exposed for tests and advanced callers; most callers use
 * {@link createDemoEnvironment}.
 */
export async function seedDemoStore(
  store: Store,
  gmail: InMemoryGmailClient,
  options: SeedDemoOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now();

  gmail.seedInbox(demoInbox(now));
  gmail.setLatestHistoryId(DEMO_HISTORY_ID);
  // Pre-existing user filters (messy) for the filter-optimisation demo.
  gmail.seedFilters(DEMO_LEGACY_FILTERS);

  await runScan(gmail, store, { now, accountEmail: DEMO_ACCOUNT_EMAIL });

  // Seed the History-API marker + onboarding so demo `Sync` is an immediate no-op refresh.
  const profile = await store.profile.get();
  if (profile !== undefined) {
    await store.profile.put({
      ...profile,
      lastHistoryId: DEMO_HISTORY_ID,
      onboardingComplete: true,
    });
  }

  // A realistic starting mix: a couple trusted, a couple blocked (with staged actions).
  for (const decision of DEMO_DECISIONS) {
    await applyDecision(store, {
      subjectId: keyFor(decision.email),
      scope: "address",
      decision: decision.decision,
      actions: decision.actions,
      decidedVia: "workflow",
      now,
    });
  }

  await seedAnalyticsHistory(store, now);
}

/**
 * Build a ready-to-use, fully in-memory demo environment: the client trio the app needs,
 * with the store pre-seeded so every screen is populated. Nothing touches Google, the
 * network, or on-device storage.
 */
export async function createDemoEnvironment(
  options: SeedDemoOptions = {},
): Promise<DemoEnvironment> {
  const now = options.now ?? Date.now();
  const gmail = new InMemoryGmailClient([], DEMO_ACCOUNT_EMAIL);
  const store = createInMemoryStore();
  const backup = new InMemoryBackupClient();
  await seedDemoStore(store, gmail, { now });
  return { gmail, store, backup };
}
