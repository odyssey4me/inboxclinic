// SPDX-License-Identifier: Apache-2.0
/**
 * `generatePrompts` — turn undecided senders into persistable trust prompts. Pure.
 *
 * See docs/design-trust-decisions.md (prompt priority, 30-day TTL) and
 * design-local-store-schema.md (`prompts` store). Only **effectively-undecided**
 * senders yield a prompt — a sender covered by a **domain** decision (unless it's a
 * per-address exception) is not prompted, so a domain decision durably suppresses its
 * members instead of re-asking them on every sync (#123). `now` is injected for
 * determinism; the function never reads the clock. One prompt per sender
 * (`prompt.id === sender.id`) so re-running a scan upserts rather than duplicates.
 */

import { effectiveSenderStatus, parentDomainRuleFor } from "../decisions/effectiveStatus";
import { keyFor } from "../keys";
import {
  emptyDecisionHistory,
  prioritisePrompts,
  type UserDecisionHistory,
} from "../prioritisation/promptPriority";
import { senderToSnapshot } from "../scoring/senderSnapshot";
import type { Domain, Prompt, Sender } from "../store/types";

/** 30-day prompt time-to-live. */
export const PROMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface GeneratePromptsOptions {
  now: number;
  /** Past block behaviour for the Alignment component. Defaults to no history. */
  history?: UserDecisionHistory;
  /** Domain decisions, so senders effectively decided by their domain aren't prompted.
   *  Omitted → falls back to each sender's own `trustStatus` (no domain override). */
  domains?: Domain[];
}

/** Pure. Build prompts for the effectively-undecided senders, ordered by priority. */
export function generatePrompts(senders: Sender[], options: GeneratePromptsOptions): Prompt[] {
  const { now } = options;
  const history = options.history ?? emptyDecisionHistory();
  // Keyed the way the precedence helpers key domains, so a parent-domain rule is found by
  // the sender's registrable domain rather than by an exact name match.
  const domainsByKey = new Map(
    (options.domains ?? []).map((domain) => [keyFor(domain.domain), domain]),
  );

  const undecided = senders.filter((sender) => {
    const domain = domainsByKey.get(keyFor(sender.domain));
    // A sender covered by a parent-domain rule is already decided, and prompting for it would
    // ask the user to re-answer a question they answered for the whole subtree (#123/#184).
    const parentRule = parentDomainRuleFor(sender.domain, domainsByKey);
    return effectiveSenderStatus(sender, domain, parentRule) === "pending";
  });
  const prioritised = prioritisePrompts(undecided.map(senderToSnapshot), history, now);

  return prioritised.map((prompt) => ({
    id: prompt.senderId,
    senderId: prompt.senderId,
    priorityScore: prompt.priorityScore,
    components: prompt.components,
    batchGroupId: prompt.batchGroupId,
    batchSize: prompt.batchSize,
    createdAt: now,
    expiresAt: now + PROMPT_TTL_MS,
    resolvedAt: null,
    deferredAt: null,
  }));
}
