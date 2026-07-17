// SPDX-License-Identifier: Apache-2.0
/**
 * Learn prior "no" decisions from the account's existing Gmail state — design-trust-
 * decisions.md Decision 8 and design-gmail-integration.md Decision 7.
 *
 * Produces **suggested** Block decisions (never applied here) from three sources:
 *  - existing native **filters** that trash/spam a sender/domain (strong signal),
 *  - **Spam**-labelled mail (strong signal),
 *  - **Trash**-ed mail, but only when it was **unread when binned** — read-then-deleted is
 *    normal triage and is not a signal (read-weighted).
 *
 * Subjects already decided (trusted or blocked) are never re-suggested. The UI presents
 * these as a confirm-first import; nothing is destructive (Gmail already handled them).
 *
 * Side effect: it also persists two trust-scoring inputs the inbox scan can't see (Decision 8)
 * — `deletedUnreadCount` (mail binned while unread) from the Trash scan, and
 * `coveredByBlockFilter` (an existing block filter matches the sender/domain) from the filter
 * scan. It's the sole populator of both, and updates **existing sender records only** (by
 * design — the signals only matter for senders the user actually sees as pending decisions,
 * which have records). A sender with no record yet is simply picked up on the next learn pass
 * after the inbox scan creates its record.
 */

import { isBlockFilter, parseFilterSubjects } from "../enforcement/filterShape";
import { keyFor } from "../keys";
import type { GmailClient } from "../ports/GmailClient";
import { extractSenders } from "../senders/extract";
import type { DecisionScope, Store } from "../store";

export type LearnReason = "filter" | "spam" | "trash";

/** A suggested Block, awaiting the user's confirmation to import. */
export interface LearnedSuggestion {
  /** Sender id for `address` scope; domain id for `domain` scope. */
  subjectId: string;
  scope: DecisionScope;
  /** Email or domain, for display. */
  label: string;
  reason: LearnReason;
  /** Messages seen in Spam/Trash for this subject (0 for filter-derived). */
  messageCount: number;
}

export interface LearnPriorOptions {
  now?: number;
  /** Spam/Trash scan window in days (default 30). */
  windowDays?: number;
  /** Hard cap on messages fetched per folder (default 200). */
  maxMessages?: number;
  /** Unread share at/above which trashed mail counts as a block signal (default 0.5). */
  unreadThreshold?: number;
}

const REASON_RANK: Record<LearnReason, number> = { filter: 3, spam: 2, trash: 1 };

export async function learnPriorDecisions(
  client: GmailClient,
  store: Store,
  options: LearnPriorOptions = {},
): Promise<LearnedSuggestion[]> {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? 30;
  const maxMessages = options.maxMessages ?? 200;
  const unreadThreshold = options.unreadThreshold ?? 0.5;

  // Never re-suggest a subject the user has already decided (trusted or blocked).
  const allSenders = await store.senders.query({});
  const decidedSenders = new Set(
    allSenders.filter((s) => s.trustStatus !== "pending").map((s) => s.id),
  );
  // Per-sender count of mail trashed **while unread** — a scoring input (Decision 8),
  // collected during the Trash scan below and persisted after.
  const trashUnreadById = new Map<string, number>();
  // Senders covered by an existing block filter (by address id or by domain) — a scoring
  // input, collected during the filter scan below and persisted after.
  const filterAddressIds = new Set<string>();
  const filterDomains = new Set<string>();
  const decidedDomains = new Set(
    (await store.domains.query({})).filter((d) => d.trustStatus !== "pending").map((d) => d.id),
  );
  const isDecided = (scope: DecisionScope, id: string): boolean =>
    scope === "domain" ? decidedDomains.has(id) : decidedSenders.has(id);

  const byId = new Map<string, LearnedSuggestion>();
  const add = (suggestion: LearnedSuggestion): void => {
    if (isDecided(suggestion.scope, suggestion.subjectId)) return;
    const prev = byId.get(suggestion.subjectId);
    if (prev === undefined) {
      byId.set(suggestion.subjectId, suggestion);
      return;
    }
    byId.set(suggestion.subjectId, {
      ...prev,
      reason:
        REASON_RANK[suggestion.reason] >= REASON_RANK[prev.reason]
          ? suggestion.reason
          : prev.reason,
      messageCount: Math.max(prev.messageCount, suggestion.messageCount),
    });
  };

  // 1. Existing native filters → block suggestions.
  let filterScanOk = true;
  try {
    for (const filter of await client.listFilters()) {
      if (!isBlockFilter(filter)) continue;
      for (const subject of parseFilterSubjects(filter.from)) {
        if (subject.scope === "domain") filterDomains.add(subject.value);
        else filterAddressIds.add(keyFor(subject.value));
        add({
          subjectId: keyFor(subject.value),
          scope: subject.scope,
          label: subject.value,
          reason: "filter",
          messageCount: 0,
        });
      }
    }
  } catch {
    // A filter read failure just yields fewer suggestions — and must not erase the signal.
    filterScanOk = false;
  }

  // 2 & 3. Spam (strong) and Trash (read-weighted) folder scans. Returns whether the scan
  // succeeded, so a transient failure doesn't reset the persisted scoring inputs below.
  const scanFolder = async (query: string, reason: "spam" | "trash"): Promise<boolean> => {
    try {
      const ids = await client.listMessageIds(`${query} newer_than:${windowDays}d`, maxMessages);
      const metas = await Promise.all(ids.map((id) => client.getMessageMeta(id)));
      const { senders } = extractSenders(metas, now);
      for (const sender of senders) {
        if (reason === "trash") {
          const unreadShare = sender.readRate === null ? 1 : 1 - sender.readRate;
          // Record the unread-trashed count for scoring, independent of the suggestion's
          // unread-share gate (Decision 8; the score threshold is applied in trustScore).
          trashUnreadById.set(sender.id, Math.round(sender.totalEmails * unreadShare));
          if (unreadShare < unreadThreshold) continue; // read-then-deleted — not a signal
        }
        add({
          subjectId: sender.id,
          scope: "address",
          label: sender.email,
          reason,
          messageCount: sender.totalEmails,
        });
      }
      return true;
    } catch {
      // A folder read failure just yields fewer suggestions — and must not erase the signal.
      return false;
    }
  };
  await scanFolder("in:spam", "spam");
  const trashScanOk = await scanFolder("in:trash", "trash");

  // Persist the learn-derived scoring inputs, but **only for scans that succeeded** — a
  // transient Gmail failure must not silently erase a previously-recorded signal. Otherwise
  // this reflects the current Trash window / filter set (senders no longer matched reset).
  for (const sender of allSenders) {
    const count = trashScanOk ? (trashUnreadById.get(sender.id) ?? 0) : sender.deletedUnreadCount;
    const covered = filterScanOk
      ? filterAddressIds.has(sender.id) || filterDomains.has(sender.domain)
      : sender.coveredByBlockFilter;
    if (sender.deletedUnreadCount !== count || sender.coveredByBlockFilter !== covered) {
      await store.senders.put({
        ...sender,
        deletedUnreadCount: count,
        coveredByBlockFilter: covered,
      });
    }
  }

  return [...byId.values()].sort(
    (a, b) => REASON_RANK[b.reason] - REASON_RANK[a.reason] || b.messageCount - a.messageCount,
  );
}
