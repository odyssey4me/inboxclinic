// SPDX-License-Identifier: Apache-2.0
/**
 * Import learned prior decisions as Block decisions on-device (design-trust-decisions.md
 * Decision 8). Confirm-first and **non-destructive**: it records the blocks (creating a
 * minimal record for Spam/Trash subjects that were never in the inbox, or blocking an
 * existing one) and stages a `create_filter` action. The caller runs `enforce` afterwards
 * to reconcile native filters — the existing Spam/Trash mail itself is untouched.
 */

import { keyFor } from "../keys";
import type { DecisionContext, Domain, Sender, Store } from "../store";
import type { LearnedSuggestion } from "./learnPriorDecisions";

function importedContext(): DecisionContext {
  return {
    readRate: null,
    totalEmails: 0,
    frequency: "rare",
    trustScore: 0,
    category: "other",
    decidedVia: "settings",
  };
}

/** A minimal blocked sender for an imported prior decision (was never scanned in the inbox). */
function blockedSender(email: string, now: number): Sender {
  const lower = email.toLowerCase();
  const domain = lower.slice(lower.indexOf("@") + 1);
  return {
    id: keyFor(lower),
    email: lower,
    domain,
    displayName: null,
    category: "other",
    trustStatus: "blocked",
    totalEmails: 0,
    hasListUnsubscribe: false,
    hasListId: false,
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
    readRate: null,
    starredCount: 0,
    spamMarkedCount: 0,
    deletedUnreadCount: 0,
    coveredByBlockFilter: false,
    replyCount: 0,
    inContacts: false,
    frequency: "rare",
    recencyBuckets: { d30: 0, d90: 0, d180: 0, older: 0 },
    auth: { spf: false, dkim: false, dmarc: false, spoofed: false },
    trustDecidedAt: now,
    decisionScope: "address",
    decisionContext: importedContext(),
    pendingActions: ["create_filter"],
  };
}

function blockedDomain(domainName: string, now: number): Domain {
  const lower = domainName.toLowerCase();
  return {
    id: keyFor(lower),
    domain: lower,
    trustStatus: "blocked",
    senderCount: 0,
    totalEmails: 0,
    exceptionAddresses: [],
    updatedAt: now,
    trustDecidedAt: now,
    decisionScope: "domain",
    decisionContext: importedContext(),
    pendingActions: ["create_filter"],
  };
}

/** Record the given suggestions as Block decisions; returns how many were imported. */
export async function importLearnedDecisions(
  store: Store,
  suggestions: LearnedSuggestion[],
  now: number = Date.now(),
): Promise<number> {
  for (const suggestion of suggestions) {
    if (suggestion.scope === "domain") {
      const existing = await store.domains.get(suggestion.subjectId);
      await store.domains.put(
        existing !== undefined
          ? {
              ...existing,
              trustStatus: "blocked",
              trustDecidedAt: now,
              decisionScope: "domain",
              pendingActions: ["create_filter"],
            }
          : blockedDomain(suggestion.label, now),
      );
    } else {
      const existing = await store.senders.get(suggestion.subjectId);
      await store.senders.put(
        existing !== undefined
          ? {
              ...existing,
              trustStatus: "blocked",
              trustDecidedAt: now,
              decisionScope: "address",
              pendingActions: ["create_filter"],
            }
          : blockedSender(suggestion.label, now),
      );
    }
  }
  return suggestions.length;
}
