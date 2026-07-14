// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  ageBuckets,
  ageInDays,
  aggregateRecency,
  bucketForAgeDays,
  emptyBuckets,
  RECENCY_WEIGHTS,
} from "./recency";

const DAY = 24 * 60 * 60 * 1000;

describe("bucketForAgeDays", () => {
  it("places ages on the correct side of each boundary", () => {
    expect(bucketForAgeDays(0)).toBe("d30");
    expect(bucketForAgeDays(30)).toBe("d30");
    expect(bucketForAgeDays(30.1)).toBe("d90");
    expect(bucketForAgeDays(90)).toBe("d90");
    expect(bucketForAgeDays(91)).toBe("d180");
    expect(bucketForAgeDays(180)).toBe("d180");
    expect(bucketForAgeDays(181)).toBe("older");
  });
});

describe("RECENCY_WEIGHTS", () => {
  it("matches the design weights", () => {
    expect(RECENCY_WEIGHTS).toEqual({ d30: 1.0, d90: 0.7, d180: 0.4, older: 0.2 });
  });
});

describe("ageInDays", () => {
  it("computes whole-day age and clamps future dates to 0", () => {
    expect(ageInDays(10 * DAY, 0)).toBe(10);
    expect(ageInDays(0, 10 * DAY)).toBe(0);
  });
});

describe("ageBuckets", () => {
  it("is a no-op for zero or negative elapsed days", () => {
    const buckets = { d30: 5, d90: 2, d180: 1, older: 3 };
    expect(ageBuckets(buckets, 0)).toEqual(buckets);
    expect(ageBuckets(buckets, -5)).toEqual(buckets);
  });

  it("splits a d30 cohort proportionally once part of it crosses into d90", () => {
    // Uniformly spread over [0,30]; after 15 days, half is now >30 days old.
    const aged = ageBuckets({ d30: 10, d90: 0, d180: 0, older: 0 }, 15);
    expect(aged.d30).toBeCloseTo(5, 5);
    expect(aged.d90).toBeCloseTo(5, 5);
    expect(aged.d180).toBe(0);
    expect(aged.older).toBe(0);
  });

  it("moves an entire cohort once elapsed time exceeds its bucket width", () => {
    const aged = ageBuckets({ d30: 10, d90: 0, d180: 0, older: 0 }, 30);
    expect(aged.d30).toBe(0);
    expect(aged.d90).toBeCloseTo(10, 5);
  });

  it("never moves `older` counts anywhere else", () => {
    const aged = ageBuckets({ d30: 0, d90: 0, d180: 0, older: 7 }, 365);
    expect(aged).toEqual({ d30: 0, d90: 0, d180: 0, older: 7 });
  });

  it("conserves the total count across buckets", () => {
    const total = (b: { d30: number; d90: number; d180: number; older: number }) =>
      b.d30 + b.d90 + b.d180 + b.older;
    const buckets = { d30: 4, d90: 3, d180: 2, older: 1 };
    expect(total(ageBuckets(buckets, 45))).toBeCloseTo(total(buckets), 5);
  });
});

describe("aggregateRecency", () => {
  it("returns 0 for an empty bucket set", () => {
    expect(aggregateRecency(emptyBuckets())).toBe(0);
  });

  it("returns 1.0 when all emails are within 30 days", () => {
    expect(aggregateRecency({ d30: 5, d90: 0, d180: 0, older: 0 })).toBe(1.0);
  });

  it("returns the weighted average across buckets", () => {
    // (1×1.0 + 1×0.7 + 1×0.4 + 1×0.2) / 4 = 0.575
    expect(aggregateRecency({ d30: 1, d90: 1, d180: 1, older: 1 })).toBeCloseTo(0.575, 5);
  });
});
