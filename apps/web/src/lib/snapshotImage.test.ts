// SPDX-License-Identifier: Apache-2.0
import type { AnalyticsSnapshot } from "@inboxclinic/core";
import { describe, expect, it } from "vitest";

import { drawSnapshot, SNAPSHOT_IMAGE_HEIGHT, SNAPSHOT_IMAGE_WIDTH } from "./snapshotImage";

const SNAPSHOT: AnalyticsSnapshot = {
  app: "Inbox Clinic",
  version: 1,
  generatedAt: new Date("2026-07-01T00:00:00.000Z").toISOString(),
  windowDays: 30,
  inboxHealthScore: 82,
  estimatedTimeSavedSeconds: 3600,
  blockedSenders: 12,
  trustedSenders: 34,
  pendingSenders: 5,
  emailsBlocked: 60,
  categories: [{ category: "promotional", senders: 8, emails: 40 }],
  achievements: ["First Block", "Trust Builder"],
};

/** A minimal fake `CanvasRenderingContext2D` that records calls instead of drawing. */
function fakeContext(): CanvasRenderingContext2D & { texts: string[] } {
  const texts: string[] = [];
  const ctx = {
    texts,
    fillStyle: "",
    font: "",
    textBaseline: "alphabetic",
    fillRect: () => {},
    fillText: (text: string) => {
      texts.push(text);
    },
    measureText: (text: string) => ({ width: text.length * 8 }) as TextMetrics,
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => {},
  };
  return ctx as unknown as CanvasRenderingContext2D & { texts: string[] };
}

describe("drawSnapshot", () => {
  it("draws the health score, stats, and earned achievements — no identifiers", () => {
    const ctx = fakeContext();
    drawSnapshot(ctx, SNAPSHOT);

    expect(ctx.texts.some((t) => t.includes("82"))).toBe(true);
    expect(ctx.texts.some((t) => t.includes("12"))).toBe(true); // blocked senders
    expect(ctx.texts.some((t) => t.includes("34"))).toBe(true); // trusted senders
    expect(ctx.texts.some((t) => t.includes("First Block"))).toBe(true);
    expect(ctx.texts.some((t) => t.includes("Trust Builder"))).toBe(true);

    // Privacy-safe: the snapshot has no sender/domain identifiers to leak, and the
    // renderer never draws anything beyond the fields on `AnalyticsSnapshot`.
    expect(ctx.texts.some((t) => t.includes("@"))).toBe(false);
    expect(ctx.texts.some((t) => t.includes("promotional"))).toBe(false);
  });

  it("skips the achievements section when none are earned", () => {
    const ctx = fakeContext();
    drawSnapshot(ctx, { ...SNAPSHOT, achievements: [] });

    expect(ctx.texts.some((t) => t.includes("ACHIEVEMENTS"))).toBe(false);
  });

  it("wraps many earned achievements onto extra rows instead of dropping them", () => {
    // All 6 possible achievements earned (design-analytics.md Decision 4) — a single pill
    // row can't hold them, so they must wrap rather than silently truncate.
    const all = [
      "First Block",
      "Trust Builder",
      "Clean Sweep",
      "Triage Master",
      "Time Saver",
      "Inbox Hero",
    ];
    const ctx = fakeContext();
    drawSnapshot(ctx, { ...SNAPSHOT, achievements: all });

    for (const name of all) {
      expect(ctx.texts.some((t) => t.includes(name))).toBe(true);
    }
  });

  it("uses the shared, fixed canvas size", () => {
    expect(SNAPSHOT_IMAGE_WIDTH).toBeGreaterThan(0);
    expect(SNAPSHOT_IMAGE_HEIGHT).toBeGreaterThan(0);
  });
});
