/**
 * Smart-default Block actions by category — pure (no I/O).
 *
 * See docs/design-trust-decisions.md (`compileActionsForBlock`) and
 * design-frontend.md (Decision phase action checkboxes). The UI seeds the Block
 * action checkboxes from these defaults; the user can override before applying.
 * `unsubscribe` is only offered when `List-Unsubscribe` is present. Execution of the
 * actions is M4 — this only suggests them.
 */

import type { BlockAction, Sender } from "../store/types";

/** Pure. Suggested default Block actions for a sender. */
export function defaultBlockActions(
  sender: Pick<Sender, "hasListUnsubscribe" | "category">,
): BlockAction[] {
  const actions: BlockAction[] = [];
  if (sender.hasListUnsubscribe) actions.push("unsubscribe");
  actions.push("create_filter");
  if (sender.category === "promotional" || sender.category === "other") {
    actions.push("archive");
  }
  return actions;
}
