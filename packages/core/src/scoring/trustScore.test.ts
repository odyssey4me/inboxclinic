// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { SenderSnapshot } from "./senderSnapshot";
import { computeTrustScore } from "./trustScore";

function snap(overrides: Partial<SenderSnapshot> = {}): SenderSnapshot {
  return {
    email: "a@b.com",
    domain: "b.com",
    category: "personal",
    totalEmails: 10,
    emails30d: 10,
    emails90d: 10,
    lastEmailAt: 0,
    readRate: 0.5,
    frequency: "weekly",
    hasListUnsubscribe: false,
    inContacts: false,
    replyCount: 0,
    starredCount: 0,
    spamMarkedCount: 0,
    deletedUnreadCount: 0,
    coveredByBlockFilter: false,
    recencyBuckets: { d30: 10, d90: 0, d180: 0, older: 0 },
    auth: { spf: false, dkim: false, dmarc: false, spoofed: false },
    ...overrides,
  };
}

describe("computeTrustScore — user signals", () => {
  it("adds replied (+3), inContacts (+2), frequently-starred (+2), consistently-opened (+1)", () => {
    const result = computeTrustScore(
      snap({ replyCount: 1, inContacts: true, starredCount: 2, readRate: 0.9 }),
    );
    expect(result.components.user).toBeCloseTo(8, 5); // 3 + 2 + 2 + 1, all at R=1.0
  });

  it("penalises never-opened (−1) and manually-marked-spam (−2)", () => {
    const result = computeTrustScore(snap({ readRate: 0, spamMarkedCount: 1 }));
    expect(result.components.user).toBeCloseTo(-3, 5);
  });

  it("penalises repeatedly-marked-spam more (−3, not −2)", () => {
    const result = computeTrustScore(snap({ readRate: 0.5, spamMarkedCount: 2 }));
    expect(result.components.user).toBeCloseTo(-3, 5);
  });

  it("penalises frequently-deleted-unread (−1) at ≥2, stacking with never-opened", () => {
    // readRate 0 → neverOpened (−1); deletedUnreadCount 2 → frequentlyDeletedUnread (−1) → −2.
    const result = computeTrustScore(snap({ readRate: 0, deletedUnreadCount: 2 }));
    expect(result.components.user).toBeCloseTo(-2, 5);
    expect(result.signals.some((s) => s.label === "frequentlyDeletedUnread")).toBe(true);
  });

  it("does not count a single deleted-unread message as 'frequently'", () => {
    const result = computeTrustScore(snap({ readRate: 0.5, deletedUnreadCount: 1 }));
    expect(result.components.user).toBe(0);
    expect(result.signals.some((s) => s.label === "frequentlyDeletedUnread")).toBe(false);
  });

  it("penalises a sender covered by a block filter (−2, not recency-scaled)", () => {
    // Low recency (all mail is old) — a recency-scaled signal would shrink to ×0.2, but a
    // standing filter is a current-state fact, so the full −2 still applies.
    const result = computeTrustScore(
      snap({ coveredByBlockFilter: true, recencyBuckets: { d30: 0, d90: 0, d180: 0, older: 10 } }),
    );
    expect(result.components.user).toBeCloseTo(-2, 5);
    expect(result.signals.some((s) => s.label === "coveredByBlockFilter")).toBe(true);
  });

  it("does not count a single star as 'frequently starred'", () => {
    expect(computeTrustScore(snap({ starredCount: 1 })).components.user).toBe(0);
  });
});

describe("computeTrustScore — recency weighting", () => {
  it("scales time-sensitive user signals by the aggregate recency factor", () => {
    const recent = computeTrustScore(
      snap({ starredCount: 2, recencyBuckets: { d30: 10, d90: 0, d180: 0, older: 0 } }),
    );
    const old = computeTrustScore(
      snap({ starredCount: 2, recencyBuckets: { d30: 0, d90: 0, d180: 0, older: 10 } }),
    );
    expect(recent.components.user).toBeCloseTo(2, 5); // 2 × 1.0
    expect(old.components.user).toBeCloseTo(0.4, 5); // 2 × 0.2
  });

  it("does not recency-scale the inContacts signal (a current-state fact)", () => {
    const result = computeTrustScore(
      snap({ inContacts: true, recencyBuckets: { d30: 0, d90: 0, d180: 0, older: 10 } }),
    );
    expect(result.components.user).toBe(2);
  });
});

describe("computeTrustScore — compliance signals", () => {
  it("awards +2 when SPF+DKIM+DMARC all pass", () => {
    const result = computeTrustScore(
      snap({ auth: { spf: true, dkim: true, dmarc: true, spoofed: false } }),
    );
    expect(result.components.compliance).toBe(2 - 1); // +2 auth, −1 no list-unsubscribe
  });

  it("awards +1 when exactly two pass", () => {
    const result = computeTrustScore(
      snap({
        hasListUnsubscribe: true,
        auth: { spf: true, dkim: true, dmarc: false, spoofed: false },
      }),
    );
    expect(result.components.compliance).toBe(1 + 1); // +1 auth, +1 list-unsubscribe
  });

  it("applies −3 when spoofed", () => {
    const result = computeTrustScore(
      snap({
        hasListUnsubscribe: true,
        auth: { spf: false, dkim: false, dmarc: false, spoofed: true },
      }),
    );
    expect(result.components.compliance).toBe(-3 + 1);
  });
});

describe("computeTrustScore — v1 weighting and result shape", () => {
  it("combines User×0.77 + Compliance×0.23 and pairs with a display tier", () => {
    const result = computeTrustScore(
      snap({
        replyCount: 1,
        inContacts: true,
        starredCount: 2,
        readRate: 0.9,
        hasListUnsubscribe: true,
        auth: { spf: true, dkim: true, dmarc: true, spoofed: false },
      }),
    );
    // user=8, compliance=3 → 0.77×8 + 0.23×3 = 6.85
    expect(result.score).toBeCloseTo(6.85, 5);
    expect(result.tier).toBe("Generally Trusted");
    expect(result.colour).toBe("light-green");
  });

  it("keeps the network component null in v1", () => {
    expect(computeTrustScore(snap()).components.network).toBeNull();
  });

  it("clamps the score within −10..+10 and exposes supporting signals", () => {
    const result = computeTrustScore(snap({ spamMarkedCount: 2, readRate: 0 }));
    expect(result.score).toBeGreaterThanOrEqual(-10);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.signals.length).toBeGreaterThan(0);
  });
});
