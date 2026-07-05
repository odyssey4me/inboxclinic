// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { dateKey, emptyDaily, monthKey, recordDailyAnalytics } from "./record";
import { createInMemoryStore } from "../testing";

const NOON = Date.UTC(2026, 5, 28, 12, 0, 0); // 2026-06-28T12:00:00Z

describe("date/month keys", () => {
  it("derive UTC YYYY-MM-DD and YYYY-MM", () => {
    expect(dateKey(NOON)).toBe("2026-06-28");
    expect(monthKey(NOON)).toBe("2026-06");
  });
});

describe("emptyDaily", () => {
  it("zeros every counter for the given date", () => {
    expect(emptyDaily("2026-06-28")).toEqual({
      date: "2026-06-28",
      newSenders: 0,
      decisionsMade: 0,
      sendersBlocked: 0,
      sendersTrusted: 0,
      emailsBlocked: 0,
      emailsRescued: 0,
    });
  });
});

describe("recordDailyAnalytics", () => {
  it("creates a day record and accumulates deltas into it", async () => {
    const store = createInMemoryStore();
    await recordDailyAnalytics(store, NOON, { newSenders: 3, decisionsMade: 1 });
    await recordDailyAnalytics(store, NOON, { decisionsMade: 2, sendersBlocked: 1 });

    const day = await store.analytics.day("2026-06-28");
    expect(day).toMatchObject({ newSenders: 3, decisionsMade: 3, sendersBlocked: 1 });
  });

  it("is a no-op when all deltas are zero or absent (no record is written)", async () => {
    const store = createInMemoryStore();
    await recordDailyAnalytics(store, NOON, {});
    await recordDailyAnalytics(store, NOON, { newSenders: 0 });

    expect(await store.analytics.day("2026-06-28")).toBeUndefined();
  });

  it("keeps separate records per day", async () => {
    const store = createInMemoryStore();
    const nextDay = NOON + 24 * 60 * 60 * 1000;
    await recordDailyAnalytics(store, NOON, { newSenders: 1 });
    await recordDailyAnalytics(store, nextDay, { newSenders: 5 });

    const days = await store.analytics.recentDays(10);
    expect(days.map((d) => [d.date, d.newSenders])).toEqual([
      ["2026-06-29", 5],
      ["2026-06-28", 1],
    ]);
  });
});
