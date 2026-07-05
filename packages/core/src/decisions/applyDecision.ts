// SPDX-License-Identifier: Apache-2.0
/**
 * `applyDecision` — record a trust decision on-device and reconcile prompts.
 *
 * See docs/design-trust-decisions.md (decisions, scope override, defer decay) and
 * docs/design-frontend.md (Execution phase). Depends only on the `Store` port, so it
 * is exercised in tests with the in-memory store fake.
 *
 * Behaviour:
 * - Records the decision on the subject (sender for `address`, domain for `domain`):
 *   `trustStatus`, `trustDecidedAt`, `decisionScope`, `decisionContext`.
 * - **Domain overrides address**: a domain decision resolves the prompts of its
 *   senders; an address decision made while a domain decision exists is recorded as
 *   an explicit exception (`domain.exceptionAddresses`).
 * - **Trust / Block** resolve the related prompt(s) (`resolvedAt = now`). **Defer**
 *   decays priority (×0.9) and marks `deferredAt` — it does not resolve the prompt.
 * - A **Block**'s `actions` are stored as `pendingActions` for M4; **no** Gmail call
 *   is made here (enforcement is M4).
 */

import { recordDailyAnalytics } from "../analytics/record";
import { computeTrustScore } from "../scoring/trustScore";
import { keyFor } from "../keys";
import { senderToSnapshot } from "../scoring/senderSnapshot";
import type { Store } from "../store";
import type {
  BlockAction,
  DecidedVia,
  Decision,
  DecisionContext,
  DecisionScope,
  Domain,
  Sender,
  TrustStatus,
} from "../store/types";

/** Defer multiplies a prompt's priority by this each time (design: ×0.9 per week). */
export const DEFER_DECAY = 0.9;

export interface ApplyDecisionInput {
  /** Sender id for `address` scope; domain id for `domain` scope. */
  subjectId: string;
  scope: DecisionScope;
  decision: Decision;
  /** Block actions to stage as pending (M4). Ignored for trust/defer. */
  actions?: BlockAction[];
  /** Provenance recorded in the decision context. Defaults to `workflow`. */
  decidedVia?: DecidedVia;
  now: number;
}

export interface ApplyDecisionResult {
  status: TrustStatus;
  resolvedPromptIds: string[];
  deferredPromptIds: string[];
  pendingActions: BlockAction[];
}

function statusFor(decision: Decision): TrustStatus {
  if (decision === "trust") return "trusted";
  if (decision === "block") return "blocked";
  return "pending"; // defer leaves the subject undecided
}

function senderContext(sender: Sender, decidedVia: DecidedVia): DecisionContext {
  return {
    readRate: sender.readRate,
    totalEmails: sender.totalEmails,
    frequency: sender.frequency,
    trustScore: computeTrustScore(senderToSnapshot(sender)).score,
    category: sender.category,
    decidedVia,
  };
}

function domainContext(domain: Domain, members: Sender[], decidedVia: DecidedVia): DecisionContext {
  const scores = members.map((m) => computeTrustScore(senderToSnapshot(m)).score);
  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return {
    readRate: null,
    totalEmails: domain.totalEmails,
    frequency: "rare",
    trustScore: avg,
    category: members[0]?.category ?? "other",
    decidedVia,
  };
}

async function resolvePrompt(store: Store, id: string, now: number): Promise<boolean> {
  const prompt = await store.prompts.get(id);
  if (prompt === undefined || prompt.resolvedAt !== null) return false;
  await store.prompts.put({ ...prompt, resolvedAt: now });
  return true;
}

async function deferPrompt(store: Store, id: string, now: number): Promise<boolean> {
  const prompt = await store.prompts.get(id);
  if (prompt === undefined || prompt.resolvedAt !== null) return false;
  await store.prompts.put({
    ...prompt,
    priorityScore: prompt.priorityScore * DEFER_DECAY,
    deferredAt: now,
  });
  return true;
}

async function applyAddressDecision(
  store: Store,
  input: ApplyDecisionInput,
): Promise<ApplyDecisionResult> {
  const { subjectId, decision, now } = input;
  const decidedVia = input.decidedVia ?? "workflow";

  const sender = await store.senders.get(subjectId);
  if (sender === undefined) throw new Error(`applyDecision: no sender ${subjectId}`);

  const status = statusFor(decision);
  const pendingActions = decision === "block" ? (input.actions ?? []) : [];

  await store.senders.put({
    ...sender,
    trustStatus: status,
    trustDecidedAt: now,
    decisionScope: "address",
    decisionContext: senderContext(sender, decidedVia),
    pendingActions,
  });

  // An address decision made under an existing domain decision is an exception.
  const domain = await store.domains.get(keyFor(sender.domain));
  if (domain?.decisionScope === "domain" && !domain.exceptionAddresses.includes(sender.email)) {
    await store.domains.put({
      ...domain,
      exceptionAddresses: [...domain.exceptionAddresses, sender.email],
    });
  }

  const resolvedPromptIds: string[] = [];
  const deferredPromptIds: string[] = [];
  if (decision === "defer") {
    if (await deferPrompt(store, subjectId, now)) deferredPromptIds.push(subjectId);
  } else if (await resolvePrompt(store, subjectId, now)) {
    resolvedPromptIds.push(subjectId);
  }

  await recordDailyAnalytics(store, now, {
    decisionsMade: 1,
    sendersTrusted: decision === "trust" ? 1 : 0,
    sendersBlocked: decision === "block" ? 1 : 0,
  });

  return { status, resolvedPromptIds, deferredPromptIds, pendingActions };
}

async function applyDomainDecision(
  store: Store,
  input: ApplyDecisionInput,
): Promise<ApplyDecisionResult> {
  const { subjectId, decision, now } = input;
  const decidedVia = input.decidedVia ?? "workflow";

  const domain = await store.domains.get(subjectId);
  if (domain === undefined) throw new Error(`applyDecision: no domain ${subjectId}`);

  const status = statusFor(decision);
  const pendingActions = decision === "block" ? (input.actions ?? []) : [];
  const members = await store.senders.query({ domain: domain.domain });

  await store.domains.put({
    ...domain,
    trustStatus: status,
    trustDecidedAt: now,
    decisionScope: "domain",
    decisionContext: domainContext(domain, members, decidedVia),
    pendingActions,
  });

  const resolvedPromptIds: string[] = [];
  const deferredPromptIds: string[] = [];
  let covered = 0;
  for (const member of members) {
    if (domain.exceptionAddresses.includes(member.email)) continue; // address exception wins
    covered += 1;
    if (decision === "defer") {
      if (await deferPrompt(store, member.id, now)) deferredPromptIds.push(member.id);
    } else if (await resolvePrompt(store, member.id, now)) {
      resolvedPromptIds.push(member.id);
    }
  }

  await recordDailyAnalytics(store, now, {
    decisionsMade: 1,
    sendersTrusted: decision === "trust" ? covered : 0,
    sendersBlocked: decision === "block" ? covered : 0,
  });

  return { status, resolvedPromptIds, deferredPromptIds, pendingActions };
}

/** Record a decision and reconcile prompts. Local-only; no Gmail call (M4 enforces). */
export function applyDecision(
  store: Store,
  input: ApplyDecisionInput,
): Promise<ApplyDecisionResult> {
  return input.scope === "domain"
    ? applyDomainDecision(store, input)
    : applyAddressDecision(store, input);
}
