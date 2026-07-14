// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  analyticsSummary,
  buildAnalyticsSummary,
  buildMonthlyAnalytics,
  buildSnapshot,
  snapshotText,
  timeSavedMinutes,
} from "./summary";
import { emptyDaily } from "./record";
import { createInMemoryStore, domainBuilder, senderBuilder } from "../testing";
import type { DailyAnalytics } from "../store/types";

const NOW = Date.UTC(2026, 5, 28, 12, 0, 0);

function day(date: string, overrides: Partial<DailyAnalytics> = {}): DailyAnalytics {
  return { ...emptyDaily(date), ...overrides };
}

describe("buildAnalyticsSummary", () => {
  const senders = [
    senderBuilder("a@x.com", { trustStatus: "trusted", readRate: 1, category: "personal" }),
    senderBuilder("b@y.com", { trustStatus: "blocked", readRate: 0, category: "promotional" }),
    senderBuilder("c@y.com", { trustStatus: "pending", readRate: null, category: "promotional" }),
  ];
  const domains = [
    domainBuilder("x.com", { totalEmails: 10, trustStatus: "trusted" }),
    domainBuilder("y.com", { totalEmails: 40, trustStatus: "blocked" }),
  ];
  const days = [
    day("2026-06-27", { emailsBlocked: 100, decisionsMade: 2, sendersBlocked: 1 }),
    day("2026-06-28", { emailsBlocked: 20, decisionsMade: 1, newSenders: 3 }),
  ];

  it("folds counters and current state into health, totals, time-saved and trend", () => {
    const summary = buildAnalyticsSummary({ now: NOW, windowDays: 30, days, senders, domains });

    expect(summary.totals).toEqual({
      senders: 3,
      domains: 2,
      trusted: 1,
      blocked: 1,
      pending: 1,
    });
    expect(summary.window.emailsBlocked).toBe(120);
    expect(summary.estimatedTimeSaved).toBe(120 * 5);
    // Trend is chronological.
    expect(summary.trend.map((p) => p.date)).toEqual(["2026-06-27", "2026-06-28"]);
    // Top blocked domain leaderboard isolates blocked domains.
    expect(summary.topBlockedDomains.map((d) => d.domain)).toEqual(["y.com"]);
    expect(summary.categories.map((c) => c.category)).toContain("promotional");
  });

  it("earns achievements from the window totals", () => {
    const heavy = [day("2026-06-28", { emailsBlocked: 1000, sendersBlocked: 1 })];
    const summary = buildAnalyticsSummary({
      now: NOW,
      windowDays: 30,
      days: heavy,
      senders,
      domains,
    });
    const earned = summary.achievements.filter((a) => a.earned).map((a) => a.id);
    expect(earned).toContain("first-block");
    expect(earned).toContain("time-saver"); // 1000 * 5s = 5000s ≥ 3600s
  });
});

describe("buildMonthlyAnalytics", () => {
  it("rolls up only the days within the month and carries the derived metrics", () => {
    const days = [
      day("2026-05-31", { emailsBlocked: 500 }), // previous month — excluded
      day("2026-06-10", { emailsBlocked: 10, decisionsMade: 1 }),
      day("2026-06-28", { emailsBlocked: 20, decisionsMade: 2 }),
    ];
    const summary = buildAnalyticsSummary({
      now: NOW,
      windowDays: 30,
      days,
      senders: [],
      domains: [],
    });
    const monthly = buildMonthlyAnalytics(NOW, days, summary);

    expect(monthly.month).toBe("2026-06");
    expect(monthly.emailsBlocked).toBe(30);
    expect(monthly.decisionsMade).toBe(3);
    expect(monthly.estimatedTimeSaved).toBe(30 * 5);
  });
});

describe("analyticsSummary (over the Store port)", () => {
  it("reads inputs, builds the summary, and persists the current-month rollup", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("a@x.com", { trustStatus: "blocked", readRate: 0 }));
    await store.analytics.putDay(day("2026-06-28", { emailsBlocked: 40, sendersBlocked: 1 }));

    const summary = await analyticsSummary(store, { now: NOW, windowDays: 30 });
    expect(summary.window.emailsBlocked).toBe(40);
    expect(summary.estimatedTimeSaved).toBe(200);

    const monthly = await store.analytics.month("2026-06");
    expect(monthly?.emailsBlocked).toBe(40);
  });

  it("still covers day 1 of the month when the window is shorter than the elapsed days", async () => {
    // A 31-day month with the default 30-day window: `recentDays(30)` returns the
    // 30 *most recent* records. With only a handful of days seeded, that trivially
    // includes the 1st regardless of the window, so the test must seed MORE than
    // `windowDays` records after the 1st for `recentDays(30)` to actually push it
    // out — reproducing the undercount the pre-fix code silently produced.
    const store = createInMemoryStore();
    const day31st = Date.UTC(2026, 6, 31, 12, 0, 0); // 2026-07-31
    await store.analytics.putDay(day("2026-07-01", { emailsBlocked: 5 }));
    for (let d = 2; d <= 31; d += 1) {
      await store.analytics.putDay(day(`2026-07-${String(d).padStart(2, "0")}`, { emailsBlocked: 1 }));
    }

    await analyticsSummary(store, { now: day31st, windowDays: 30 });

    const monthly = await store.analytics.month("2026-07");
    // 5 (day 1) + 30 (days 2-31, one each) = 35. Pre-fix, `recentDays(30)` returns
    // only days 2-31 (the 30 most recent), dropping day 1 and yielding 30.
    expect(monthly?.emailsBlocked).toBe(35);
  });
});

describe("snapshot (privacy-safe, opt-in)", () => {
  it("carries only aggregate numbers — no identifiers", () => {
    const summary = buildAnalyticsSummary({
      now: NOW,
      windowDays: 30,
      days: [day("2026-06-28", { emailsBlocked: 60, sendersBlocked: 1 })],
      senders: [
        senderBuilder("secret@private.com", { trustStatus: "blocked", category: "promotional" }),
      ],
      domains: [domainBuilder("private.com", { trustStatus: "blocked", totalEmails: 60 })],
    });
    const snapshot = buildSnapshot(summary);
    const json = JSON.stringify(snapshot);

    expect(json).not.toContain("private.com");
    expect(json).not.toContain("secret@");
    expect(snapshot.app).toBe("Inbox Clinic");
    expect(snapshot.emailsBlocked).toBe(60);
    expect(snapshot.blockedSenders).toBe(1);
  });

  it("renders a copyable text summary with health and time saved", () => {
    const summary = buildAnalyticsSummary({
      now: NOW,
      windowDays: 30,
      days: [day("2026-06-28", { emailsBlocked: 120, sendersBlocked: 1 })],
      senders: [senderBuilder("a@x.com", { trustStatus: "blocked", readRate: 1 })],
      domains: [],
    });
    const text = snapshotText(buildSnapshot(summary));
    expect(text).toContain("Inbox health:");
    expect(text).toContain("Time saved:");
  });

  it("converts seconds to whole minutes", () => {
    expect(timeSavedMinutes(150)).toBe(3); // 2.5 min → 3
    expect(timeSavedMinutes(0)).toBe(0);
  });
});
