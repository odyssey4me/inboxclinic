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
 * - **Defer only touches an undecided subject.** Applied to a subject that already
 *   carries a Trust/Block decision, it is a no-op on the subject's record (status,
 *   pendingActions, decision context all untouched) — otherwise "not sure" would
 *   silently revert an already-decided sender and, via enforcement, delete its live
 *   Gmail filter.
 * - A **Block**'s `actions` are stored as `pendingActions` for M4; **no** Gmail call
 *   is made here (enforcement is M4).
 */

import { recordDailyAnalytics } from "../analytics/record";
import { computeTrustScore } from "../scoring/trustScore";
import { registrableDomain } from "../domains/registrableDomain";
import { isSubdomainOf } from "../domains/subtree";
import { keyFor } from "../keys";
import { SCOPE_SPECIFICITY } from "./resolveEffectiveDecision";
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

/**
 * The broader rules currently covering a sender domain: its own record when domain-scoped, the
 * registrable domain's record when that carries a parent-domain rule, and any **domain-scope
 * block above it in the subtree**.
 *
 * A narrower decision made under any of them must be recorded as an exception on it, or the
 * broader rule silently overrides the decision the user just made — the failure #167 fixed
 * for domains, which a parent rule reintroduces one level up.
 *
 * Every level is written, not just the nearest: each blocked domain compiles to its own filter
 * and its own sweep, so a sender excepted from only some of them is still trashed by the rest.
 */
async function broaderRulesFor(store: Store, senderDomain: string): Promise<Domain[]> {
  const rules: Domain[] = [];
  const exact = await store.domains.get(keyFor(senderDomain));
  // The sender's own record can carry EITHER kind of rule: when a domain is its own
  // registrable domain, the parent rule over that subtree lives on this same row. Matching
  // only `"domain"` here would find no broader rule at all for an apex sender, so trusting
  // `someone@example.com` under a blocked parent rule on `example.com` would record no
  // carve-out — and the compiled filter would go on trashing mail the user just protected.
  if (exact?.decisionScope === "domain" || exact?.decisionScope === "parentDomain") {
    rules.push(exact);
  }

  const registrable = registrableDomain(senderDomain);
  if (registrable !== null && keyFor(registrable) !== keyFor(senderDomain)) {
    const parent = await store.domains.get(keyFor(registrable));
    if (parent?.decisionScope === "parentDomain") rules.push(parent);
  }

  // A domain-scope BLOCK reaches its whole subtree, because `*@domain` is not an exact match
  // (#210, measured). So it is a broader rule over senders at its subdomains too, even where
  // those subdomains are undecided records of their own — and without this, trusting
  // `statements@email.monzo.com` under a `monzo.com` block recorded no carve-out anywhere,
  // and the sweep and the filter went on trashing the sender the user had just protected
  // (#244). A domain-scope *trust* is not such a rule: it compiles to nothing, so there is no
  // reach to carve out of.
  for (const blocked of await store.domains.query({ trustStatus: "blocked" })) {
    if (blocked.decisionScope === "domain" && isSubdomainOf(senderDomain, blocked.domain)) {
      rules.push(blocked);
    }
  }
  return rules;
}

async function applyAddressDecision(
  store: Store,
  input: ApplyDecisionInput,
): Promise<ApplyDecisionResult> {
  const { subjectId, decision, now } = input;
  const decidedVia = input.decidedVia ?? "workflow";

  const sender = await store.senders.get(subjectId);
  if (sender === undefined) throw new Error(`applyDecision: no sender ${subjectId}`);

  // Defer on an already-decided sender must not revert it — see module docs.
  const noOp = decision === "defer" && sender.trustStatus !== "pending";
  const status = noOp ? sender.trustStatus : statusFor(decision);
  const pendingActions = noOp
    ? sender.pendingActions
    : decision === "block"
      ? (input.actions ?? [])
      : [];

  if (!noOp) {
    await store.senders.put({
      ...sender,
      trustStatus: status,
      trustDecidedAt: now,
      decisionScope: "address",
      decisionContext: senderContext(sender, decidedVia),
      pendingActions,
    });

    // An address decision made under an existing broader rule is an exception to it. Defer is
    // not such a decision — it leaves the subject undecided (`statusFor`) and only decays the
    // prompt, so it must not write into a field whose entries record a deliberate carve-out
    // from a rule (#195). Both the exact domain and the registrable domain can carry one, and
    // each records the carve-out on its own record.
    if (decision !== "defer") {
      for (const rule of await broaderRulesFor(store, sender.domain)) {
        if (rule.exceptionAddresses.includes(sender.email)) continue;
        await store.domains.put({
          ...rule,
          exceptionAddresses: [...rule.exceptionAddresses, sender.email],
        });
      }
    }
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

  // A `parentDomain`-scoped record must be its own registrable domain — `parentDomainRuleFor`
  // and `broaderRulesFor` both look up a subtree's rule by exact key on the registrable domain,
  // so a record violating this would be silently unreachable from any subdomain (#230). Fail
  // loudly here rather than let a bad caller write a decision the resolution model can't find.
  if (input.scope === "parentDomain") {
    const registrable = registrableDomain(domain.domain);
    if (registrable !== domain.domain.toLowerCase()) {
      throw new Error(
        `applyDecision: parentDomain scope requires ${subjectId} (${domain.domain}) to be its own registrable domain, got ${registrable}`,
      );
    }
  }

  // Defer on an already-decided domain must not revert it — see module docs.
  const noOp = decision === "defer" && domain.trustStatus !== "pending";
  const status = noOp ? domain.trustStatus : statusFor(decision);
  const pendingActions = noOp
    ? domain.pendingActions
    : decision === "block"
      ? (input.actions ?? [])
      : [];
  // A parent-domain rule covers every sender under the registrable domain, so its members
  // cannot be found by exact-name match the way an exact-domain decision's are.
  const members =
    input.scope === "parentDomain"
      ? (await store.senders.query({})).filter(
          (sender) => registrableDomain(sender.domain) === domain.domain.toLowerCase(),
        )
      : await store.senders.query({ domain: domain.domain });

  if (!noOp) {
    await store.domains.put({
      ...domain,
      trustStatus: status,
      trustDecidedAt: now,
      decisionScope: input.scope,
      decisionContext: domainContext(domain, members, decidedVia),
      pendingActions,
    });

    // A decision on an exact domain under a parent-domain rule carves that subdomain out of
    // the parent, the same way an address decision carves itself out of a domain rule.
    if (decision !== "defer" && input.scope === "domain") {
      const registrable = registrableDomain(domain.domain);
      if (registrable !== null && keyFor(registrable) !== keyFor(domain.domain)) {
        const parent = await store.domains.get(keyFor(registrable));
        if (
          parent?.decisionScope === "parentDomain" &&
          !parent.exceptionDomains.includes(domain.domain)
        ) {
          await store.domains.put({
            ...parent,
            exceptionDomains: [...parent.exceptionDomains, domain.domain],
          });
        }
      }
    }
  }

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
  // Both domain scopes act on a `Domain` record; only the recorded scope and the members
  // they cover differ, so `parentDomain` must not fall through to the address branch.
  return input.scope === "address"
    ? applyAddressDecision(store, input)
    : applyDomainDecision(store, input);
}

/** The settled outcome of one decision in an `applyDecisions` batch. */
export interface AppliedDecision {
  /** The input decision, echoed so callers can align outcomes with their own labels/order. */
  input: ApplyDecisionInput;
  /** Present on success. */
  result?: ApplyDecisionResult;
  /** Present on failure — the batch continues; this decision is left unrecorded. */
  error?: string;
}

export interface ApplyDecisionsOptions {
  /**
   * Called after each decision settles (in applied — i.e. domain-first — order), for progress
   * UI. The returned array is still input-ordered; this is only a per-item notification.
   */
  onSettled?: (outcome: AppliedDecision) => void;
}

/**
 * Apply a batch of decisions in one pass, **domain-scope decisions first**.
 *
 * `applyAddressDecision` records an address as a domain **exception** only when the sender's
 * domain is *already* domain-scoped in the store (`decisionScope === "domain"`). So for a batch
 * that both blocks a domain and decides one of its members ("block the domain but keep this
 * sender"), the domain decision must land first — otherwise the address decision runs against a
 * not-yet-scoped domain, no exception is recorded, and the later domain block silently overrides
 * the member (its mail gets trashed). A caller applying in submission order can't guarantee that;
 * this entrypoint does, so preview (`simulate.ts`) and apply agree regardless of submission order
 * (#167). Sequential (each decision may read state a prior one wrote) and per-item resilient (one
 * failure doesn't abort the rest); outcomes are returned in the original input order.
 */
export async function applyDecisions(
  store: Store,
  inputs: readonly ApplyDecisionInput[],
  options: ApplyDecisionsOptions = {},
): Promise<AppliedDecision[]> {
  const outcomes: AppliedDecision[] = inputs.map((input) => ({ input }));
  // Apply in scope order (domain first) over a stable-sorted copy that shares the same outcome
  // objects, so mutating each outcome updates `outcomes` in place while it keeps INPUT order.
  const ordered = [...outcomes].sort((a, b) => scopeRank(a.input.scope) - scopeRank(b.input.scope));
  for (const outcome of ordered) {
    try {
      outcome.result = await applyDecision(store, outcome.input);
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    options.onSettled?.(outcome);
  }
  return outcomes;
}

/**
 * Apply order: **broadest first**, the mirror of the specificity ladder. Derived from
 * `SCOPE_SPECIFICITY` rather than restated, so a new scope cannot be added with an
 * accidental order — the map is exhaustive over `DecisionScope` and fails to compile
 * without an entry.
 */
const scopeRank = (scope: DecisionScope): number => -SCOPE_SPECIFICITY[scope];
