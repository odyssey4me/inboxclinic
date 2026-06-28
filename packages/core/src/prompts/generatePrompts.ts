/**
 * `generatePrompts` — turn undecided senders into persistable trust prompts. Pure.
 *
 * See docs/design-trust-decisions.md (prompt priority, 30-day TTL) and
 * design-local-store-schema.md (`prompts` store). Only **undecided** (`pending`)
 * senders yield a prompt. `now` is injected for determinism; the function never
 * reads the clock. One prompt per sender (`prompt.id === sender.id`) so re-running a
 * scan upserts rather than duplicates.
 */

import {
  emptyDecisionHistory,
  prioritisePrompts,
  type UserDecisionHistory,
} from "../prioritisation/promptPriority";
import { senderToSnapshot } from "../scoring/senderSnapshot";
import type { Prompt, Sender } from "../store/types";

/** 30-day prompt time-to-live. */
export const PROMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface GeneratePromptsOptions {
  now: number;
  /** Past block behaviour for the Alignment component. Defaults to no history. */
  history?: UserDecisionHistory;
}

/** Pure. Build prompts for the undecided senders, ordered by priority. */
export function generatePrompts(senders: Sender[], options: GeneratePromptsOptions): Prompt[] {
  const { now } = options;
  const history = options.history ?? emptyDecisionHistory();

  const undecided = senders.filter((sender) => sender.trustStatus === "pending");
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
