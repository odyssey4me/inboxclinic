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
 */

import { keyFor } from "../keys";
import type { GmailClient, NativeFilter } from "../ports/GmailClient";
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

/** A filter that removes the mail from the inbox (trash / spam / archive) is a block. */
function isBlockShaped(filter: NativeFilter): boolean {
  return (
    filter.addLabelIds.includes("TRASH") ||
    filter.addLabelIds.includes("SPAM") ||
    filter.removeLabelIds.includes("INBOX")
  );
}

/** Parse a filter `from` ("a@x.com", "*@x.com", or "*@a.com OR *@b.com") into subjects. */
function parseFilterSubjects(from: string): { scope: DecisionScope; value: string }[] {
  const out: { scope: DecisionScope; value: string }[] = [];
  for (const token of from.split(/\s+OR\s+/i)) {
    const value = token.trim().toLowerCase();
    if (value === "") continue;
    if (value.startsWith("*@")) out.push({ scope: "domain", value: value.slice(2) });
    else if (value.includes("@")) out.push({ scope: "address", value });
  }
  return out;
}

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
  const decidedSenders = new Set(
    (await store.senders.query({})).filter((s) => s.trustStatus !== "pending").map((s) => s.id),
  );
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
  try {
    for (const filter of await client.listFilters()) {
      if (!isBlockShaped(filter)) continue;
      for (const subject of parseFilterSubjects(filter.from)) {
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
    // A filter read failure just yields fewer suggestions.
  }

  // 2 & 3. Spam (strong) and Trash (read-weighted) folder scans.
  const scanFolder = async (query: string, reason: "spam" | "trash"): Promise<void> => {
    try {
      const ids = await client.listMessageIds(`${query} newer_than:${windowDays}d`, maxMessages);
      const metas = await Promise.all(ids.map((id) => client.getMessageMeta(id)));
      const { senders } = extractSenders(metas, now);
      for (const sender of senders) {
        if (reason === "trash") {
          const unreadShare = sender.readRate === null ? 1 : 1 - sender.readRate;
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
    } catch {
      // A folder read failure just yields fewer suggestions.
    }
  };
  await scanFolder("in:spam", "spam");
  await scanFolder("in:trash", "trash");

  return [...byId.values()].sort(
    (a, b) => REASON_RANK[b.reason] - REASON_RANK[a.reason] || b.messageCount - a.messageCount,
  );
}
