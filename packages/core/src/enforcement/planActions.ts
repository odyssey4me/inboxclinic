// SPDX-License-Identifier: Apache-2.0
/**
 * Action planning — pure (no I/O).
 *
 * See docs/design-trust-decisions.md (Block actions: unsubscribe / create_filter /
 * archive / delete, and Trust rescue) and design-gmail-integration.md (the message
 * label semantics the actions compile into). `planActions` maps a single subject's
 * decision + staged actions into the concrete operations enforcement performs:
 *
 * - **create_filter** → handled at the set level (`compileFilters`); surfaced here as a
 *   flag for transparency.
 * - **archive** → remove `INBOX` from the subject's existing messages.
 * - **delete** → add `TRASH` (and remove `INBOX`); takes precedence over archive.
 * - **unsubscribe** → only when `List-Unsubscribe` is present.
 * - **Trust rescue** → a `trust` decision on a spam-marked sender removes `SPAM`/`TRASH`
 *   from its existing messages.
 */

import type { BlockAction, Decision } from "../store/types";
import type { MessageLabelEdit } from "../ports/GmailClient";

export interface ActionPlan {
  /** Whether a native filter should exist for this subject (realised by compileFilters). */
  createFilter: boolean;
  /** Whether an unsubscribe was requested and is permitted (List-Unsubscribe present). */
  unsubscribe: boolean;
  /** Label edit to apply to the subject's existing messages, or `null` when none. */
  messageMutation: MessageLabelEdit | null;
}

export interface PlanActionsInput {
  decision: Decision;
  /** Staged block actions (block decisions only). */
  actions?: BlockAction[];
  /** Whether the subject exposes a `List-Unsubscribe` header. */
  hasListUnsubscribe?: boolean;
  /** Messages marked spam (>0 triggers a Trust rescue). */
  spamMarkedCount?: number;
}

const RESCUE_MUTATION: MessageLabelEdit = { removeLabelIds: ["SPAM", "TRASH"] };

/** Pure. Compile a subject's decision into the concrete enforcement operations. */
export function planActions(input: PlanActionsInput): ActionPlan {
  if (input.decision === "block") {
    const actions = input.actions ?? [];
    const createFilter = actions.includes("create_filter");
    const unsubscribe = actions.includes("unsubscribe") && (input.hasListUnsubscribe ?? false);

    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];
    if (actions.includes("delete")) {
      addLabelIds.push("TRASH");
      removeLabelIds.push("INBOX");
    } else if (actions.includes("archive")) {
      removeLabelIds.push("INBOX");
    }
    const messageMutation =
      addLabelIds.length > 0 || removeLabelIds.length > 0 ? { addLabelIds, removeLabelIds } : null;

    return { createFilter, unsubscribe, messageMutation };
  }

  if (input.decision === "trust") {
    const needsRescue = (input.spamMarkedCount ?? 0) > 0;
    return {
      createFilter: false,
      unsubscribe: false,
      messageMutation: needsRescue ? { ...RESCUE_MUTATION } : null,
    };
  }

  // Defer (or any non-acting decision) compiles to no operations.
  return { createFilter: false, unsubscribe: false, messageMutation: null };
}
