import { describe, expect, it } from "vitest";

import {
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
