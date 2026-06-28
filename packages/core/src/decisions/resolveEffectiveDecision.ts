/**
 * `resolveEffectiveDecision` — pure precedence rule (no I/O).
 *
 * See docs/design-trust-decisions.md (Decision 2): a **domain** decision overrides an
 * **address** decision for senders in that domain, unless the address is recorded as
 * an explicit exception (then the address decision wins).
 */

import type { DecisionScope, TrustStatus } from "../store/types";

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
