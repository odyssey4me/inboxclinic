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
