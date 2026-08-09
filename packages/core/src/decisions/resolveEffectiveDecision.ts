// SPDX-License-Identifier: Apache-2.0
/**
 * `resolveEffectiveDecision` — pure precedence rule (no I/O).
 *
 * See docs/design-trust-decisions.md (Decision 2): a **domain** decision overrides an
 * **address** decision for senders in that domain, unless the address is recorded as
 * an explicit exception (then the address decision wins).
 */

import type { DecisionScope, TrustStatus } from "../store/types";

/**
 * The specificity ladder as data — **lower rank wins** (design-trust-decisions.md Decision 9).
 * An `address` decision is the most specific, a `parentDomain` rule the broadest default.
 *
 * The point of a map rather than a chain of `=== "domain"` checks is that `Record<DecisionScope,
 * number>` makes the ladder *machine-checkable*: adding a scope — the public-suffix/TLD scope of
 * #180 is the one already anticipated — fails to compile until it is given a rank, instead of
 * silently sorting last or being missed at one of several comparison sites.
 *
 * Resolution still runs on Decision 2's two scopes; #184 rewrites `resolveEffectiveDecision`
 * to compare ranks and fold in `parentDomain`.
 */
export const SCOPE_SPECIFICITY: Record<DecisionScope, number> = {
  address: 0,
  domain: 1,
  parentDomain: 2,
};

/** True when `a` is the more specific of two scopes, and so wins under most-specific-wins. */
export function isMoreSpecific(a: DecisionScope, b: DecisionScope): boolean {
  return SCOPE_SPECIFICITY[a] < SCOPE_SPECIFICITY[b];
}

export interface EffectiveDecisionInput {
  addressStatus: TrustStatus | null;
  addressIsException: boolean;
  domainStatus: TrustStatus | null;
  domainScope: DecisionScope | null;
}

export interface EffectiveDecision {
  status: TrustStatus;
  source: "address" | "domain" | "none";
}

/** Pure. Resolve the effective status for a sender given address + domain decisions. */
export function resolveEffectiveDecision(input: EffectiveDecisionInput): EffectiveDecision {
  const { addressStatus, addressIsException, domainStatus, domainScope } = input;

  // A domain-scope decision overrides the address, except for explicit exceptions.
  if (domainStatus !== null && domainScope === "domain" && !addressIsException) {
    return { status: domainStatus, source: "domain" };
  }
  if (addressStatus !== null) return { status: addressStatus, source: "address" };
  if (domainStatus !== null) return { status: domainStatus, source: "domain" };
  return { status: "pending", source: "none" };
}
