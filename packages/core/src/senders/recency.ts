/**
 * Recency bucketing and weighting — pure helpers shared by extraction and scoring.
 *
 * See docs/design-trust-decisions.md ("Recency weights"): ≤30d ×1.0, 30–90d ×0.7,
 * 90–180d ×0.4, >180d ×0.2. The same boundaries define the on-device
 * `RecencyBuckets` counts (store/types.ts).
 */

import type { RecencyBuckets } from "../store/types";

export type RecencyBucket = keyof RecencyBuckets;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The design's recency weight per bucket. */
export const RECENCY_WEIGHTS: Record<RecencyBucket, number> = {
  d30: 1.0,
  d90: 0.7,
  d180: 0.4,
  older: 0.2,
};

/** Whole-day age of `then` relative to `now` (negative ages clamp to 0). */
export function ageInDays(now: number, then: number): number {
  return Math.max(0, (now - then) / DAY_MS);
}

/** The (non-overlapping) recency bucket an age in days falls into. */
export function bucketForAgeDays(days: number): RecencyBucket {
  if (days <= 30) return "d30";
  if (days <= 90) return "d90";
  if (days <= 180) return "d180";
  return "older";
}

/** An empty bucket set. */
export function emptyBuckets(): RecencyBuckets {
  return { d30: 0, d90: 0, d180: 0, older: 0 };
}

/**
 * Recency-weighted average over a bucket set, in `[0.2, 1.0]` (`0` when empty).
 * Used to scale time-sensitive user signals toward recent activity.
 */
export function aggregateRecency(buckets: RecencyBuckets): number {
  const total = buckets.d30 + buckets.d90 + buckets.d180 + buckets.older;
  if (total <= 0) return 0;
  const weighted =
    buckets.d30 * RECENCY_WEIGHTS.d30 +
    buckets.d90 * RECENCY_WEIGHTS.d90 +
    buckets.d180 * RECENCY_WEIGHTS.d180 +
    buckets.older * RECENCY_WEIGHTS.older;
  return weighted / total;
}
