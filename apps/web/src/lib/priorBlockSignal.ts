// SPDX-License-Identifier: Apache-2.0
import type { Sender } from "@inboxclinic/core";

/**
 * Whether a sender already carries a **prior-block signal** — mail marked spam, binned while
 * unread, or covered by an existing block filter (design-trust-decisions.md Decision 8). These
 * are the senders surfaced for one-step consolidation in the detail panel (#96).
 */
export function hasPriorBlockSignal(sender: Sender): boolean {
  return sender.spamMarkedCount > 0 || sender.deletedUnreadCount > 0 || sender.coveredByBlockFilter;
}

/**
 * The **flagged siblings** of `sender`: same-domain senders that carry a prior-block signal,
 * drawn from the caller's `pending` (undecided) set — offered for one-step consolidated
 * block/keep (design-trust-decisions.md Decision 8, #96). `pending` is the caller's notion of
 * "still undecided": effective status on the dashboard, the unhandled queue in the guided
 * workflow. `sender` itself is excluded.
 */
export function flaggedSiblingsOf(sender: Sender, pending: Sender[]): Sender[] {
  return pending.filter(
    (s) => s.id !== sender.id && s.domain === sender.domain && hasPriorBlockSignal(s),
  );
}
