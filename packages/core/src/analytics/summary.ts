// SPDX-License-Identifier: Apache-2.0
/**
 * Analytics summary — on-demand monthly rollup and derived metrics.
 *
 * `buildAnalyticsSummary` is pure: it folds the persisted daily counters together with
 * the current sender/domain state into everything the Analytics view renders (health,
 * time-saved, breakdowns, top domains, a trend, and achievements). `analyticsSummary`
 * is the thin orchestrator that reads those inputs from the `Store` port and persists
 * the current-month rollup. See docs/design-analytics.md.
 */

import {
  achievements,
  categoryBreakdown,
  estimatedTimeSaved,
  healthInputFromSenders,
  inboxHealthScore,
  topDomainsByVolume,
  type Achievement,
  type CategoryStat,
  type DomainVolume,
} from "./metrics";
import { monthKey } from "./record";
import type { Store } from "../store";
import type { DailyAnalytics, Domain, MonthlyAnalytics, Sender } from "../store/types";

/** Default analytics window (days) — the dashboard's "30-day summary". */
export const DEFAULT_WINDOW_DAYS = 30;

/** Top-N size for the domain leaderboards. */
const TOP_DOMAINS_LIMIT = 5;

/** Summed daily counters over a window. */
export interface WindowTotals {
  newSenders: number;
  decisionsMade: number;
  sendersBlocked: number;
  sendersTrusted: number;
  emailsBlocked: number;
  emailsRescued: number;
}

/** One point on the activity trend (per day, chronological). */
export interface TrendPoint {
  date: string;
  emailsBlocked: number;
  decisionsMade: number;
  newSenders: number;
}

export interface AnalyticsSummary {
  generatedAt: number;
  windowDays: number;
  inboxHealthScore: number;
  totals: {
    senders: number;
    domains: number;
    trusted: number;
    blocked: number;
    pending: number;
  };
  /** Counters summed across the window's days. */
  window: WindowTotals;
  /** Estimated time saved (seconds), from the window's blocked-email volume. */
  estimatedTimeSaved: number;
  categories: CategoryStat[];
  topDomains: DomainVolume[];
  topBlockedDomains: DomainVolume[];
  trend: TrendPoint[];
  achievements: Achievement[];
}

export interface BuildAnalyticsSummaryInput {
  now: number;
  windowDays: number;
  days: DailyAnalytics[];
  senders: Sender[];
  domains: Domain[];
}

function sumDays(days: DailyAnalytics[]): WindowTotals {
  const totals: WindowTotals = {
    newSenders: 0,
    decisionsMade: 0,
    sendersBlocked: 0,
    sendersTrusted: 0,
    emailsBlocked: 0,
    emailsRescued: 0,
  };
  for (const day of days) {
    totals.newSenders += day.newSenders;
    totals.decisionsMade += day.decisionsMade;
    totals.sendersBlocked += day.sendersBlocked;
    totals.sendersTrusted += day.sendersTrusted;
    totals.emailsBlocked += day.emailsBlocked;
    totals.emailsRescued += day.emailsRescued;
  }
  return totals;
}

/** Pure fold of daily counters + current state into the full Analytics summary. */
export function buildAnalyticsSummary(input: BuildAnalyticsSummaryInput): AnalyticsSummary {
  const { now, windowDays, days, senders, domains } = input;

  const healthInput = healthInputFromSenders(senders);
  const health = inboxHealthScore(healthInput);
  const window = sumDays(days);
  const timeSaved = estimatedTimeSaved(window.emailsBlocked);

  const trend: TrendPoint[] = [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      emailsBlocked: d.emailsBlocked,
      decisionsMade: d.decisionsMade,
      newSenders: d.newSenders,
    }));

  return {
    generatedAt: now,
    windowDays,
    inboxHealthScore: health,
    totals: {
      senders: senders.length,
      domains: domains.length,
      trusted: healthInput.trusted,
      blocked: healthInput.blocked,
      pending: healthInput.pending,
    },
    window,
    estimatedTimeSaved: timeSaved,
    categories: categoryBreakdown(senders),
    topDomains: topDomainsByVolume(domains, TOP_DOMAINS_LIMIT),
    topBlockedDomains: topDomainsByVolume(domains, TOP_DOMAINS_LIMIT, { status: "blocked" }),
    trend,
    achievements: achievements({
      decisionsMade: window.decisionsMade,
      sendersBlocked: window.sendersBlocked,
      sendersTrusted: window.sendersTrusted,
      emailsBlocked: window.emailsBlocked,
      estimatedTimeSavedSeconds: timeSaved,
      inboxHealthScore: health,
    }),
  };
}

/** Build the persistable monthly rollup for the month containing `now`. */
export function buildMonthlyAnalytics(
  now: number,
  days: DailyAnalytics[],
  summary: AnalyticsSummary,
): MonthlyAnalytics {
  const month = monthKey(now);
  const inMonth = days.filter((d) => d.date.startsWith(month));
  const totals = sumDays(inMonth);
  return {
    month,
    ...totals,
    inboxHealthScore: summary.inboxHealthScore,
    estimatedTimeSaved: estimatedTimeSaved(totals.emailsBlocked),
    achievements: summary.achievements.filter((a) => a.earned).map((a) => a.id),
  };
}

export interface AnalyticsSummaryOptions {
  /** Injected clock for deterministic tests; defaults to `Date.now()`. */
  now?: number;
  /** Window size in days (default 30). */
  windowDays?: number;
}

/**
 * Read the analytics inputs from the store, build the summary, and persist the
 * current-month rollup. Thin over the `Store` port (the maths is all in pure
 * functions), so it is exercised against the in-memory store fake.
 */
export async function analyticsSummary(
  store: Store,
  options: AnalyticsSummaryOptions = {},
): Promise<AnalyticsSummary> {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;

  const [senders, domains, days] = await Promise.all([
    store.senders.query({}),
    store.domains.query({}),
    store.analytics.recentDays(windowDays),
  ]);

  const summary = buildAnalyticsSummary({ now, windowDays, days, senders, domains });

  // The rolling `days` window can be shorter than the elapsed days in the current
  // month (e.g. the default 30-day window on day 31), which would silently drop
  // day 1 from the persisted rollup. Re-fetch a wider slice when that happens.
  const dayOfMonth = new Date(now).getUTCDate();
  const monthDays = dayOfMonth <= windowDays ? days : await store.analytics.recentDays(dayOfMonth);

  await store.analytics.putMonth(buildMonthlyAnalytics(now, monthDays, summary));
  return summary;
}

// --- Shareable snapshot (opt-in, local-only) -----------------------------------

/** Schema/version marker for an exported snapshot artifact. */
export const SNAPSHOT_VERSION = 1;

/**
 * A self-contained, privacy-safe snapshot the user may choose to share. It carries
 * **only aggregate numbers** — no sender/domain identifiers, no email addresses — so
 * publishing it leaks nothing about who emails the user (design-analytics.md, §5/§7).
 */
export interface AnalyticsSnapshot {
  app: "Inbox Clinic";
  version: number;
  generatedAt: string; // ISO-8601
  windowDays: number;
  inboxHealthScore: number;
  estimatedTimeSavedSeconds: number;
  blockedSenders: number;
  trustedSenders: number;
  pendingSenders: number;
  emailsBlocked: number;
  categories: { category: string; senders: number; emails: number }[];
  achievements: string[];
}

/** Build the privacy-safe snapshot object from a summary (pure). */
export function buildSnapshot(summary: AnalyticsSummary): AnalyticsSnapshot {
  return {
    app: "Inbox Clinic",
    version: SNAPSHOT_VERSION,
    generatedAt: new Date(summary.generatedAt).toISOString(),
    windowDays: summary.windowDays,
    inboxHealthScore: summary.inboxHealthScore,
    estimatedTimeSavedSeconds: summary.estimatedTimeSaved,
    blockedSenders: summary.totals.blocked,
    trustedSenders: summary.totals.trusted,
    pendingSenders: summary.totals.pending,
    emailsBlocked: summary.window.emailsBlocked,
    categories: summary.categories.map((c) => ({
      category: c.category,
      senders: c.senders,
      emails: c.emails,
    })),
    achievements: summary.achievements.filter((a) => a.earned).map((a) => a.name),
  };
}

/** Round seconds to whole minutes for human-readable summaries. */
export function timeSavedMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/** Render a snapshot as a copyable plain-text summary (pure; no identifiers). */
export function snapshotText(snapshot: AnalyticsSnapshot): string {
  const lines = [
    `Inbox Clinic — my inbox at a glance`,
    `Inbox health: ${snapshot.inboxHealthScore}/100`,
    `Blocked ${snapshot.blockedSenders} senders, trusted ${snapshot.trustedSenders}`,
    `Time saved: ~${timeSavedMinutes(snapshot.estimatedTimeSavedSeconds)} min`,
  ];
  if (snapshot.achievements.length > 0) {
    lines.push(`Achievements: ${snapshot.achievements.join(", ")}`);
  }
  return lines.join("\n");
}
