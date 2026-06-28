import type { BlockAction, Decision, DecisionScope } from "@inboxclinic/core";

/**
 * One staged decision in the in-memory pending list (design-frontend.md Decision 6:
 * nothing is persisted until Execution). `coveredSenderIds` records which queue
 * senders this change accounts for, so the queue and Review stay in sync.
 */
export interface PendingDecision {
  subjectId: string; // sender id (address) or domain id (domain)
  scope: DecisionScope;
  decision: Decision;
  actions: BlockAction[];
  label: string; // email or domain, for display
  coveredSenderIds: string[];
}
