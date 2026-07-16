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

import { resolveEffectiveDecision } from "../decisions/resolveEffectiveDecision";
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
  const domainByName = new Map((options.domains ?? []).map((domain) => [domain.domain, domain]));

  const undecided = senders.filter((sender) => {
    const domain = domainByName.get(sender.domain);
    return (
      resolveEffectiveDecision({
        addressStatus: sender.trustStatus === "pending" ? null : sender.trustStatus,
        addressIsException: domain?.exceptionAddresses.includes(sender.email) ?? false,
        domainStatus: domain && domain.trustStatus !== "pending" ? domain.trustStatus : null,
        domainScope: domain?.decisionScope ?? null,
      }).status === "pending"
    );
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
