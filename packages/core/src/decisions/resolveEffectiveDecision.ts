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
  /** The registrable domain's rule, when one exists (Decision 9). */
  parentDomainStatus?: TrustStatus | null;
  /**
   * True when this sender — by address, or by its exact domain — is recorded as an exception
   * to the parent-domain rule, so that rule steps aside for the narrower decision.
   */
  parentDomainIsException?: boolean;
}

export interface EffectiveDecision {
  status: TrustStatus;
  source: "address" | "domain" | "parentDomain" | "none";
}

/**
 * Pure. Resolve the effective status for a sender across the specificity ladder.
 *
 * The rule reads backwards from "most specific wins", and deliberately so: a **broader rule
 * overrides a narrower decision unless the narrower subject is recorded as an exception to
 * it**. That is what makes a domain decision meaningful at all — deciding a whole domain has
 * to move senders already decided individually, or it would do nothing for exactly the
 * senders the user knows about. Recording an exception is how the user says "not this one",
 * and it is written whenever a narrower decision is made under a broader rule
 * (`applyDecision`), so the two stay in step.
 *
 * Applied across three levels, broadest first: a parent-domain rule (the registrable domain)
 * gives way to an excepted subdomain or address; an exact-domain decision gives way to an
 * excepted address; otherwise the narrowest decision present wins. A level with no decision
 * is simply skipped, so an undecided middle never blocks a broader rule from applying.
 *
 * See design-trust-decisions.md Decision 2 (domain over address) and Decision 9 (parent
 * domain, most-specific-wins).
 */
export function resolveEffectiveDecision(input: EffectiveDecisionInput): EffectiveDecision {
  const {
    addressStatus,
    addressIsException,
    domainStatus,
    domainScope,
    parentDomainStatus = null,
    parentDomainIsException = false,
  } = input;

  // Broadest first: each rule applies unless the narrower subject is carved out of it.
  if (parentDomainStatus !== null && !parentDomainIsException) {
    return { status: parentDomainStatus, source: "parentDomain" };
  }
  // A domain record can carry its rule at `"domain"` scope (an exact-domain decision) or, when
  // the domain IS its own registrable domain, at `"parentDomain"` scope (the rule for its own
  // subtree lives on this same record — `parentDomainRuleFor` finds no separate parent to
  // resolve above). Either way it is this sender's exact-domain rule, so both scopes override
  // an un-excepted address the same way; only the reported `source` differs.
  if (
    domainStatus !== null &&
    (domainScope === "domain" || domainScope === "parentDomain") &&
    !addressIsException
  ) {
    return { status: domainStatus, source: domainScope };
  }

  // No broader rule claims this sender, so the narrowest decision it has stands.
  if (addressStatus !== null) return { status: addressStatus, source: "address" };
  if (domainStatus !== null) return { status: domainStatus, source: "domain" };
  if (parentDomainStatus !== null) return { status: parentDomainStatus, source: "parentDomain" };
  return { status: "pending", source: "none" };
}
