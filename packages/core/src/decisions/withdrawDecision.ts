// SPDX-License-Identifier: Apache-2.0
/**
 * `withdrawDecision` — stop deciding a subject, so the rules above it govern again.
 *
 * Every other operation here *makes* a decision. This removes one, and it is not the same as
 * deciding the opposite: a subject can be flipped between trusted and blocked forever without
 * ever returning to *following* the rule that covers it. Without this, deciding anything is
 * permanent — the natural sequence "trust this subdomain → later block the whole subtree →
 * actually, include that subdomain after all" has no final step (#225).
 *
 * Two things have to happen together, or the model and the behaviour diverge:
 *
 * 1. the subject's own decision record is cleared, so it is undecided rather than decided-
 *    to-agree — otherwise a later change to the broader rule silently fails to reach it;
 * 2. it is removed from every broader rule's exception list, since an exception means "this
 *    one is carved out", and a subject that has withdrawn is precisely not carved out.
 *
 * Doing only (1) leaves a carve-out for a decision that no longer exists; only (2) leaves the
 * subject overriding the rule it was meant to rejoin.
 *
 * **No prompt is generated here.** A subject a broader rule still covers is decided — just not
 * by itself — and prompting would re-ask a question the broader decision already answered
 * (#123). One that nothing covers is genuinely undecided, and `generatePrompts` builds prompts
 * for exactly that set on the next scan, so it reappears on its own without this duplicating
 * that logic. **Nothing is written to history either:** the decision record is being cleared,
 * so there is nothing left for an entry to describe.
 *
 * Local-only, like `applyDecision` — the caller reconciles Gmail afterwards, because the
 * effective status can move in either direction.
 */

import { registrableDomain } from "../domains/registrableDomain";
import { keyFor } from "../keys";
import { effectiveSenderStatus, parentDomainRuleFor } from "./effectiveStatus";
import type { Store } from "../store";
import type { DecisionScope, Domain, TrustStatus } from "../store/types";

export interface WithdrawDecisionInput {
  /** Sender id for `address` scope; domain id for a domain or parent-domain rule. */
  subjectId: string;
  scope: DecisionScope;
}

export interface WithdrawDecisionResult {
  /** The subject's effective status now the broader rules apply to it again. */
  status: TrustStatus;
  /** Domains whose exception list the subject was removed from. */
  clearedExceptionsOn: string[];
  /** False when there was no decision to withdraw — the call is then a no-op. */
  withdrawn: boolean;
}

/** Every domain record, keyed for the precedence helpers. */
async function domainsByKey(store: Store): Promise<Map<string, Domain>> {
  const domains = await store.domains.query({});
  return new Map(domains.map((d) => [keyFor(d.domain), d]));
}

/** Clear a subject from a rule's exception lists, returning the rule if anything changed. */
async function dropException(
  store: Store,
  rule: Domain,
  { email, domain }: { email?: string; domain?: string },
): Promise<boolean> {
  const addresses = rule.exceptionAddresses.filter(
    (entry) => email === undefined || keyFor(entry) !== keyFor(email),
  );
  const domains = rule.exceptionDomains.filter(
    (entry) => domain === undefined || keyFor(entry) !== keyFor(domain),
  );
  if (
    addresses.length === rule.exceptionAddresses.length &&
    domains.length === rule.exceptionDomains.length
  ) {
    return false;
  }
  await store.domains.put({ ...rule, exceptionAddresses: addresses, exceptionDomains: domains });
  return true;
}

/**
 * Withdraw the subject's own decision so the rules above it apply again.
 *
 * A subject with no decision of its own is left untouched and reported as `withdrawn: false`,
 * rather than treated as an error — "stop deciding this" is already true of it.
 */
export async function withdrawDecision(
  store: Store,
  input: WithdrawDecisionInput,
): Promise<WithdrawDecisionResult> {
  const byKey = await domainsByKey(store);
  const clearedExceptionsOn: string[] = [];

  if (input.scope === "address") {
    const sender = await store.senders.get(input.subjectId);
    if (sender === undefined) throw new Error(`withdrawDecision: no sender ${input.subjectId}`);

    const hadDecision = sender.trustStatus !== "pending" || sender.decisionScope !== null;
    if (hadDecision) {
      await store.senders.put({
        ...sender,
        trustStatus: "pending",
        trustDecidedAt: null,
        decisionScope: null,
        decisionContext: null,
        // Staged actions belong to the decision being withdrawn; leaving them would let a
        // later enforce apply a block the user has just stepped back from.
        pendingActions: [],
      });
    }

    // Its own domain record, and the registrable domain's rule, can each hold a carve-out.
    // `parentDomainRuleFor` narrows to the fields precedence reads, so the full record is
    // taken from the map to write back — a partial one would drop everything else on it.
    const parentRule = parentDomainRuleFor(sender.domain, byKey);
    const rules = [
      byKey.get(keyFor(sender.domain)),
      parentRule === undefined ? undefined : byKey.get(keyFor(parentRule.domain)),
    ];
    for (const rule of rules) {
      if (rule === undefined) continue;
      if (await dropException(store, rule, { email: sender.email })) {
        clearedExceptionsOn.push(rule.domain);
      }
    }

    const fresh = await domainsByKey(store);
    const status = effectiveSenderStatus(
      { email: sender.email, trustStatus: "pending" },
      fresh.get(keyFor(sender.domain)),
      parentDomainRuleFor(sender.domain, fresh),
    );
    return { status, clearedExceptionsOn, withdrawn: hadDecision };
  }

  const domain = await store.domains.get(input.subjectId);
  if (domain === undefined) throw new Error(`withdrawDecision: no domain ${input.subjectId}`);

  const hadDecision = domain.trustStatus !== "pending" || domain.decisionScope !== null;
  if (hadDecision) {
    await store.domains.put({
      ...domain,
      trustStatus: "pending",
      trustDecidedAt: null,
      decisionScope: null,
      decisionContext: null,
      pendingActions: [],
    });
  }

  // A subdomain carved out of a parent rule is recorded on that rule, not on itself.
  const registrable = registrableDomain(domain.domain);
  if (registrable !== null && keyFor(registrable) !== keyFor(domain.domain)) {
    const parent = byKey.get(keyFor(registrable));
    if (parent?.decisionScope === "parentDomain") {
      if (await dropException(store, parent, { domain: domain.domain })) {
        clearedExceptionsOn.push(parent.domain);
      }
    }
  }

  // A domain's own effective status is whatever the rule above it now says.
  const fresh = await domainsByKey(store);
  const parentRule = parentDomainRuleFor(domain.domain, fresh);
  const status: TrustStatus =
    parentRule !== undefined && !parentRule.exceptionDomains.includes(domain.domain)
      ? parentRule.trustStatus
      : "pending";
  return { status, clearedExceptionsOn, withdrawn: hadDecision };
}
