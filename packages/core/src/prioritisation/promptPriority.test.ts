// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "../keys";
import type { SenderSnapshot } from "../scoring/senderSnapshot";
import type { UserDecisionHistory } from "./promptPriority";
import { emptyDecisionHistory, prioritisePrompts } from "./promptPriority";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function snap(overrides: Partial<SenderSnapshot> = {}): SenderSnapshot {
  return {
    email: "a@b.com",
    domain: "b.com",
    category: "personal",
    totalEmails: 50,
    emails30d: 10,
    emails90d: 20,
    lastEmailAt: NOW,
    readRate: 0.5,
    frequency: "weekly",
    hasListUnsubscribe: false,
    inContacts: false,
    replyCount: 0,
    starredCount: 0,
    spamMarkedCount: 0,
    deletedUnreadCount: 0,
    coveredByBlockFilter: false,
    recencyBuckets: { d30: 10, d90: 10, d180: 0, older: 30 },
    auth: { spf: false, dkim: false, dmarc: false, spoofed: false },
    ...overrides,
  };
}

describe("prioritisePrompts — component sub-formulas", () => {
  it("computes Impact = volume(≤0.5) + frequency + recency(≤0.2)", () => {
    const [prompt] = prioritisePrompts(
      [snap({ totalEmails: 50, frequency: "weekly", lastEmailAt: NOW })],
      emptyDecisionHistory(),
      NOW,
    );
    // volume = min(50/100,1)×0.5 = 0.25; frequency weekly = 0.2; recency(age 0) = 0.2
    expect(prompt?.components.impact).toBeCloseTo(0.65, 5);
  });

  it("computes Confidence = readTerm + listUnsub + historyLen + categoryConsistency", () => {
    const [prompt] = prioritisePrompts(
      [snap({ readRate: 1, hasListUnsubscribe: true, totalEmails: 50, category: "personal" })],
      emptyDecisionHistory(),
      NOW,
    );
    // |1−0.5|×2×0.4 = 0.4; listUnsub 0.2; historyLen min(50/50,1)×0.2 = 0.2; category 0.2
    expect(prompt?.components.confidence).toBeCloseTo(1.0, 5);
  });

  it("zeroes the read term when readRate is null and the category term for 'other'", () => {
    const [prompt] = prioritisePrompts(
      [snap({ readRate: null, hasListUnsubscribe: false, totalEmails: 0, category: "other" })],
      emptyDecisionHistory(),
      NOW,
    );
    expect(prompt?.components.confidence).toBeCloseTo(0, 5);
  });

  it("scores recency at 0.1 for 30–90 days and 0 beyond 90 days", () => {
    const [mid] = prioritisePrompts(
      [snap({ totalEmails: 0, frequency: "rare", lastEmailAt: NOW - 60 * DAY })],
      emptyDecisionHistory(),
      NOW,
    );
    const [old] = prioritisePrompts(
      [snap({ totalEmails: 0, frequency: "rare", lastEmailAt: NOW - 200 * DAY })],
      emptyDecisionHistory(),
      NOW,
    );
    // impact = volume(0) + frequency(rare 0.05) + recency
    expect(mid?.components.impact).toBeCloseTo(0.15, 5);
    expect(old?.components.impact).toBeCloseTo(0.05, 5);
  });
});

describe("prioritisePrompts — batch grouping", () => {
  it("groups 3+ same-domain senders and reports the batch size", () => {
    const prompts = prioritisePrompts(
      [
        snap({ email: "a@x.com", domain: "x.com" }),
        snap({ email: "b@x.com", domain: "x.com" }),
        snap({ email: "c@x.com", domain: "x.com" }),
      ],
      emptyDecisionHistory(),
      NOW,
    );
    expect(prompts[0]?.batchGroupId).toBe("domain:x.com");
    expect(prompts[0]?.batchSize).toBe(3);
    // domainGrouping 0.4 (3+) + combinedVolume min(150/200,1)×0.4 = 0.3 → 0.7
    expect(prompts[0]?.components.batch).toBeCloseTo(0.7, 5);
  });

  it("leaves a lone sender unbatched", () => {
    const [prompt] = prioritisePrompts([snap({ domain: "solo.com" })], emptyDecisionHistory(), NOW);
    expect(prompt?.batchGroupId).toBeNull();
    expect(prompt?.batchSize).toBe(1);
  });

  it("scales domain grouping with the cluster size (2 → 0.2, 5+ → 0.6)", () => {
    const pair = prioritisePrompts(
      [snap({ email: "a@p.com", domain: "p.com" }), snap({ email: "b@p.com", domain: "p.com" })],
      emptyDecisionHistory(),
      NOW,
    );
    expect(pair[0]?.batchSize).toBe(2);
    // domainGrouping 0.2 + combinedVolume min(100/200,1)×0.4 = 0.2
    expect(pair[0]?.components.batch).toBeCloseTo(0.4, 5);

    const five = prioritisePrompts(
      ["a", "b", "c", "d", "e"].map((u) => snap({ email: `${u}@q.com`, domain: "q.com" })),
      emptyDecisionHistory(),
      NOW,
    );
    expect(five[0]?.batchSize).toBe(5);
    // domainGrouping 0.6 + combinedVolume min(250/200,1)×0.4 = 0.4 → 1.0
    expect(five[0]?.components.batch).toBeCloseTo(1.0, 5);
  });
});

describe("prioritisePrompts — alignment", () => {
  it("returns the neutral 0.5 with no decision history", () => {
    const [prompt] = prioritisePrompts([snap()], emptyDecisionHistory(), NOW);
    expect(prompt?.components.alignment).toBe(0.5);
  });

  it("exposes a zero-rate, no-decisions empty history", () => {
    const history = emptyDecisionHistory();
    expect(history.hasDecisions).toBe(false);
    expect(history.blockRateForCategory("personal")).toBe(0);
    expect(history.blockRateForTld("com")).toBe(0);
    expect(history.blockRateForReadBand(0.5)).toBe(0);
  });

  it("blends category/tld/read-band block rates when history exists", () => {
    const history: UserDecisionHistory = {
      blockRateForCategory: () => 1,
      blockRateForTld: () => 1,
      blockRateForReadBand: () => 1,
      hasDecisions: true,
    };
    const [prompt] = prioritisePrompts([snap()], history, NOW);
    expect(prompt?.components.alignment).toBeCloseTo(1.0, 5); // 0.5 + 0.3 + 0.2
  });
});

describe("prioritisePrompts — score and ordering", () => {
  it("scales the weighted sum to 0–100 and sorts highest-first", () => {
    const prompts = prioritisePrompts(
      [
        snap({ email: "low@quiet.com", domain: "quiet.com", totalEmails: 1, frequency: "rare" }),
        snap({ email: "high@busy.com", domain: "busy.com", totalEmails: 100, frequency: "daily" }),
      ],
      emptyDecisionHistory(),
      NOW,
    );
    expect(prompts[0]?.senderId).toBe(keyFor("high@busy.com"));
    expect(prompts[1]?.senderId).toBe(keyFor("low@quiet.com"));
    for (const prompt of prompts) {
      expect(prompt.priorityScore).toBeGreaterThanOrEqual(0);
      expect(prompt.priorityScore).toBeLessThanOrEqual(100);
    }
  });

  it("returns an empty array for no candidates", () => {
    expect(prioritisePrompts([], emptyDecisionHistory(), NOW)).toEqual([]);
  });
});
