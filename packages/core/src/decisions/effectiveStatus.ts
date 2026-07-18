// SPDX-License-Identifier: Apache-2.0
/**
 * Effective-status helpers for enforcement — resolve the domain-override + exception rule
 * (design-trust-decisions.md Decision 2) so enforcement acts on the *effective* decision,
 * not raw `trustStatus`. Reading raw status keeps a Gmail block filter alive for a sender the
 * user has since trusted at the domain level (#144). Mirrors what `generatePrompts` (#123) and
 * the Dashboard already do; the enforcement path was the outlier still reading raw status.
 */

import { keyFor } from "../keys";
import type { Store } from "../store";
import type { Domain, Sender, TrustStatus } from "../store/types";
import { resolveEffectiveDecision } from "./resolveEffectiveDecision";

const nonPending = (status: TrustStatus): TrustStatus | null =>
  status === "pending" ? null : status;

/** The effective trust status of a sender, resolving its domain's override + exceptions. */
export function effectiveSenderStatus(
  sender: Pick<Sender, "email" | "trustStatus">,
  domain: Pick<Domain, "trustStatus" | "decisionScope" | "exceptionAddresses"> | undefined,
): TrustStatus {
  return resolveEffectiveDecision({
    addressStatus: nonPending(sender.trustStatus),
    addressIsException: domain?.exceptionAddresses.includes(sender.email) ?? false,
    domainStatus: domain ? nonPending(domain.trustStatus) : null,
    domainScope: domain?.decisionScope ?? null,
  }).status;
}

/**
 * The address-blocked senders whose block still stands after domain resolution — i.e. NOT
 * overridden by a domain-scope trust (unless the address is a recorded exception). This is the
 * set enforcement must compile into filters and act on, replacing a raw
 * `store.senders.query({ trustStatus: "blocked" })` that would keep blocking a domain-trusted
 * sender (#144).
 */
export async function effectiveBlockedSenders(store: Store): Promise<Sender[]> {
  const blocked = await store.senders.query({ trustStatus: "blocked" });
  if (blocked.length === 0) return blocked;
  const domains = await store.domains.query({});
  const byKey = new Map(domains.map((d) => [keyFor(d.domain), d]));
  return blocked.filter((s) => effectiveSenderStatus(s, byKey.get(keyFor(s.domain))) === "blocked");
}
