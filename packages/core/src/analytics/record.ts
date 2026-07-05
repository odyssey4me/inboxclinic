// SPDX-License-Identifier: Apache-2.0
/**
 * Analytics recording — thin accumulation of daily counters over the `Store` port.
 *
 * The scan/sync/decision/enforce orchestrations call `recordDailyAnalytics` to add
 * reconstruction-proof counters (design-analytics.md). All maths stays in the pure
 * functions in metrics.ts / summary.ts; this module only reads-modifies-writes a
 * `DailyAnalytics` record, so it is trivial to exercise against the in-memory store.
 */

import type { Store } from "../store";
import type { DailyAnalytics } from "../store/types";

/** A partial set of daily counter deltas to add to a day's record. */
export type DailyDelta = Partial<Omit<DailyAnalytics, "date">>;

/** UTC `YYYY-MM-DD` key for an epoch-ms instant. */
export function dateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** UTC `YYYY-MM` key for an epoch-ms instant. */
export function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** A zeroed daily record for `date`. */
export function emptyDaily(date: string): DailyAnalytics {
  return {
    date,
    newSenders: 0,
    decisionsMade: 0,
    sendersBlocked: 0,
    sendersTrusted: 0,
    emailsBlocked: 0,
    emailsRescued: 0,
  };
}

/**
 * Add `delta` to the counters of the day that contains `now` (creating the record if
 * absent). A no-op when every delta is zero/absent, so callers can record
 * unconditionally without churn.
 */
export async function recordDailyAnalytics(
  store: Store,
  now: number,
  delta: DailyDelta,
): Promise<void> {
  const total =
    (delta.newSenders ?? 0) +
    (delta.decisionsMade ?? 0) +
    (delta.sendersBlocked ?? 0) +
    (delta.sendersTrusted ?? 0) +
    (delta.emailsBlocked ?? 0) +
    (delta.emailsRescued ?? 0);
  if (total === 0) return;

  const date = dateKey(now);
  const current = (await store.analytics.day(date)) ?? emptyDaily(date);
  await store.analytics.putDay({
    date,
    newSenders: current.newSenders + (delta.newSenders ?? 0),
    decisionsMade: current.decisionsMade + (delta.decisionsMade ?? 0),
    sendersBlocked: current.sendersBlocked + (delta.sendersBlocked ?? 0),
    sendersTrusted: current.sendersTrusted + (delta.sendersTrusted ?? 0),
    emailsBlocked: current.emailsBlocked + (delta.emailsBlocked ?? 0),
    emailsRescued: current.emailsRescued + (delta.emailsRescued ?? 0),
  });
}
