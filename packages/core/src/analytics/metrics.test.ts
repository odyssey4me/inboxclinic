import { describe, expect, it } from "vitest";

import {
  achievements,
  categoryBreakdown,
  estimatedTimeSaved,
  healthInputFromSenders,
  inboxHealthScore,
  topDomainsByVolume,
  HEALTH_NEUTRAL,
  SECONDS_PER_BLOCKED_EMAIL,
} from "./metrics";
import { domainBuilder, senderBuilder } from "../testing";
import type { AchievementInput } from "./metrics";

describe("inboxHealthScore", () => {
  it("is neutral when there is nothing to assess", () => {
    expect(inboxHealthScore({ trusted: 0, blocked: 0, pending: 0, avgReadRate: null })).toBe(
      HEALTH_NEUTRAL,
    );
  });

  it("reaches 100 when fully triaged, all blocked, and fully read", () => {
    expect(inboxHealthScore({ trusted: 0, blocked: 10, pending: 0, avgReadRate: 1 })).toBe(100);
  });

  it("scores 80 when fully triaged and all trusted with full read rate (no hygiene)", () => {
    expect(inboxHealthScore({ trusted: 10, blocked: 0, pending: 0, avgReadRate: 1 })).toBe(80);
  });

  it("scores low when nothing is decided (coverage and hygiene are zero)", () => {
    // read fallback 0.5 → 0.3 * 0.5 = 0.15 → 15.
    expect(inboxHealthScore({ trusted: 0, blocked: 0, pending: 8, avgReadRate: null })).toBe(15);
  });

  it("uses the read fallback (0.5) only when no read rate is supplied", () => {
    // half decided (all blocked) + read 0 → coverage 0.5*0.5=0.25, hygiene 0.2*1=0.2 → 45.
    expect(inboxHealthScore({ trusted: 0, blocked: 5, pending: 5, avgReadRate: 0 })).toBe(45);
  });

  it("never exceeds its 0–100 bounds", () => {
    const score = inboxHealthScore({ trusted: 3, blocked: 7, pending: 0, avgReadRate: 1 });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("healthInputFromSenders", () => {
  it("counts statuses and averages read rates only over senders that have one", () => {
    const input = healthInputFromSenders([
      senderBuilder("a@x.com", { trustStatus: "trusted", readRate: 1 }),
      senderBuilder("b@x.com", { trustStatus: "blocked", readRate: 0 }),
      senderBuilder("c@x.com", { trustStatus: "pending", readRate: null }),
    ]);
    expect(input).toEqual({ trusted: 1, blocked: 1, pending: 1, avgReadRate: 0.5 });
  });

  it("reports a null average when no sender has a read rate", () => {
    const input = healthInputFromSenders([senderBuilder("a@x.com", { readRate: null })]);
    expect(input.avgReadRate).toBeNull();
  });
});

describe("estimatedTimeSaved", () => {
  it("scales the blocked-email volume by the per-email constant", () => {
    expect(estimatedTimeSaved(100)).toBe(100 * SECONDS_PER_BLOCKED_EMAIL);
  });

  it("rounds fractional volumes and floors non-positive / non-finite input at zero", () => {
    expect(estimatedTimeSaved(2.4)).toBe(2 * SECONDS_PER_BLOCKED_EMAIL);
    expect(estimatedTimeSaved(0)).toBe(0);
    expect(estimatedTimeSaved(-5)).toBe(0);
    expect(estimatedTimeSaved(Number.NaN)).toBe(0);
  });
});

describe("categoryBreakdown", () => {
  it("groups senders by category, highest email volume first", () => {
    const breakdown = categoryBreakdown([
      senderBuilder("a@x.com", { category: "promotional", totalEmails: 5 }),
      senderBuilder("b@x.com", { category: "promotional", totalEmails: 3 }),
      senderBuilder("c@y.com", { category: "personal", totalEmails: 20 }),
    ]);
    expect(breakdown).toEqual([
      { category: "personal", senders: 1, emails: 20 },
      { category: "promotional", senders: 2, emails: 8 },
    ]);
  });

  it("returns nothing for an empty sender set", () => {
    expect(categoryBreakdown([])).toEqual([]);
  });
});

describe("topDomainsByVolume", () => {
  const domains = [
    domainBuilder("a.com", { totalEmails: 10, senderCount: 2, trustStatus: "blocked" }),
    domainBuilder("b.com", { totalEmails: 30, senderCount: 1, trustStatus: "trusted" }),
    domainBuilder("c.com", { totalEmails: 20, senderCount: 4, trustStatus: "blocked" }),
  ];

  it("returns the highest-volume domains, capped at the limit", () => {
    expect(topDomainsByVolume(domains, 2).map((d) => d.domain)).toEqual(["b.com", "c.com"]);
  });

  it("filters by trust status when requested", () => {
    const blocked = topDomainsByVolume(domains, 5, { status: "blocked" });
    expect(blocked.map((d) => d.domain)).toEqual(["c.com", "a.com"]);
  });
});

describe("achievements", () => {
  const base: AchievementInput = {
    decisionsMade: 0,
    sendersBlocked: 0,
    sendersTrusted: 0,
    emailsBlocked: 0,
    estimatedTimeSavedSeconds: 0,
    inboxHealthScore: 0,
  };

  const earned = (input: AchievementInput): string[] =>
    achievements(input)
      .filter((a) => a.earned)
      .map((a) => a.id);

  it("earns nothing at zero", () => {
    expect(earned(base)).toEqual([]);
  });

  it("earns First Block at the first block but not Clean Sweep until ten", () => {
    expect(earned({ ...base, sendersBlocked: 1 })).toEqual(["first-block"]);
    expect(earned({ ...base, sendersBlocked: 10 })).toEqual(["first-block", "clean-sweep"]);
  });

  it("crosses each documented threshold exactly", () => {
    expect(earned({ ...base, sendersTrusted: 10 })).toContain("trust-builder");
    expect(earned({ ...base, decisionsMade: 50 })).toContain("triage-master");
    expect(earned({ ...base, estimatedTimeSavedSeconds: 3600 })).toContain("time-saver");
    expect(earned({ ...base, estimatedTimeSavedSeconds: 3599 })).not.toContain("time-saver");
    expect(earned({ ...base, inboxHealthScore: 80 })).toContain("inbox-hero");
    expect(earned({ ...base, inboxHealthScore: 79 })).not.toContain("inbox-hero");
  });

  it("returns every rule with an earned flag", () => {
    expect(achievements(base)).toHaveLength(6);
  });
});
