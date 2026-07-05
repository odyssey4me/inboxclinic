// SPDX-License-Identifier: Apache-2.0
/**
 * `SenderSnapshot` — the read-only projection the pure scorers consume.
 *
 * See docs/design-trust-decisions.md ("SenderSnapshot"). It carries only plain data
 * (no store handles, no I/O). v1 represents user-behaviour signals as the concrete,
 * metadata-derived aggregate counts the scan produces (read rate, starred / spam
 * counts, recency buckets) rather than the design's abstract per-signal
 * `userSignals` map; per-signal recency bucketing is a documented future refinement
 * — recency weighting is applied at the sender-aggregate level (see trustScore.ts).
 */

import type {
  AuthSignals,
  Frequency,
  RecencyBuckets,
  Sender,
  SenderCategory,
} from "../store/types";

export interface SenderSnapshot {
  email: string;
  domain: string;
  category: SenderCategory;
  totalEmails: number;
  emails30d: number;
  emails90d: number;
  lastEmailAt: number;
  readRate: number | null;
  frequency: Frequency;
  hasListUnsubscribe: boolean;
  inContacts: boolean;
  replyCount: number;
  starredCount: number;
  spamMarkedCount: number;
  recencyBuckets: RecencyBuckets;
  auth: AuthSignals;
}

/** Project a persisted `Sender` into the scorer input. Pure, no I/O. */
export function senderToSnapshot(sender: Sender): SenderSnapshot {
  const { recencyBuckets } = sender;
  return {
    email: sender.email,
    domain: sender.domain,
    category: sender.category,
    totalEmails: sender.totalEmails,
    emails30d: recencyBuckets.d30,
    emails90d: recencyBuckets.d30 + recencyBuckets.d90,
    lastEmailAt: sender.lastSeenAt,
    readRate: sender.readRate,
    frequency: sender.frequency,
    hasListUnsubscribe: sender.hasListUnsubscribe,
    inContacts: sender.inContacts,
    replyCount: sender.replyCount,
    starredCount: sender.starredCount,
    spamMarkedCount: sender.spamMarkedCount,
    recencyBuckets,
    auth: sender.auth,
  };
}
