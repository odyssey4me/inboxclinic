// SPDX-License-Identifier: Apache-2.0
/**
 * Effective-status helpers for enforcement — resolve the domain-override + exception rule
 * (design-trust-decisions.md Decision 2) so enforcement acts on the *effective* decision,
 * not raw `trustStatus`. Reading raw status keeps a Gmail block filter alive for a sender the
 * user has since trusted at the domain level (#144). Mirrors what `generatePrompts` (#123) and
 * the Dashboard already do; the enforcement path was the outlier still reading raw status.
 */

import { registrableDomain } from "../domains/registrableDomain";
import { keyFor } from "../keys";
import type { Store } from "../store";
import type { Domain, Sender, TrustStatus } from "../store/types";
import { resolveEffectiveDecision } from "./resolveEffectiveDecision";

const nonPending = (status: TrustStatus): TrustStatus | null =>
  status === "pending" ? null : status;

/** The fields of a `Domain` record the precedence rule reads. */
type DomainRule = Pick<
  Domain,
  "domain" | "trustStatus" | "decisionScope" | "exceptionAddresses" | "exceptionDomains"
>;

/**
 * Find the **parent-domain rule** covering a sender, if one exists: the `Domain` record for
 * the sender's registrable domain, carrying `decisionScope: "parentDomain"`.
 *
 * A record for the eTLD+1 exists whenever mail has been seen from it, so the scope check is
 * what distinguishes "a rule over the whole subtree" from "a decision about that one domain"
 * — `example.com` may be both, and only the former reaches `news.example.com`.
 */
export function parentDomainRuleFor(
  senderDomain: string,
  domainsByKey: ReadonlyMap<string, DomainRule>,
): DomainRule | undefined {
  const registrable = registrableDomain(senderDomain);
  // No eTLD+1 (a bare public suffix, or an unparseable host) means no rule can key on it.
  if (registrable === null) return undefined;
  // A domain IS its own registrable domain — the rule then applies to it directly, and the
  // exact-domain branch would say the same thing, so there is nothing extra to resolve.
  if (keyFor(registrable) === keyFor(senderDomain)) return undefined;
  const rule = domainsByKey.get(keyFor(registrable));
  return rule?.decisionScope === "parentDomain" ? rule : undefined;
}

/**
 * The effective trust status of a sender, resolving the parent-domain rule, the exact-domain
 * override, and address exceptions (design-trust-decisions.md Decisions 2 and 9).
 */
export function effectiveSenderStatus(
  sender: Pick<Sender, "email" | "trustStatus">,
  domain: DomainRule | undefined,
  parentRule?: DomainRule | undefined,
): TrustStatus {
  // The parent rule steps aside when this sender, or its exact domain, is carved out of it.
  const exceptedFromParent =
    parentRule !== undefined &&
    (parentRule.exceptionAddresses.includes(sender.email) ||
      (domain !== undefined && parentRule.exceptionDomains.includes(domain.domain)));

  return resolveEffectiveDecision({
    addressStatus: nonPending(sender.trustStatus),
    addressIsException: domain?.exceptionAddresses.includes(sender.email) ?? false,
    domainStatus: domain ? nonPending(domain.trustStatus) : null,
    domainScope: domain?.decisionScope ?? null,
    parentDomainStatus: parentRule ? nonPending(parentRule.trustStatus) : null,
    parentDomainIsException: exceptedFromParent,
  }).status;
}

/** Every domain record keyed for lookup — both exact-domain and parent-domain rules. */
async function domainRulesByKey(store: Store): Promise<Map<string, Domain>> {
  const domains = await store.domains.query({});
  return new Map(domains.map((d) => [keyFor(d.domain), d]));
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
  const byKey = await domainRulesByKey(store);
  return blocked.filter(
    (s) =>
      effectiveSenderStatus(
        s,
        byKey.get(keyFor(s.domain)),
        parentDomainRuleFor(s.domain, byKey),
      ) === "blocked",
  );
}

/**
 * The senders whose EFFECTIVE status is trusted — raw-trusted senders not overridden by a
 * domain block, plus senders trusted via a domain-scope trust (raw status still blocked/pending).
 * This is the set trust-rescue must pull back out of SPAM/TRASH, replacing a raw
 * `store.senders.query({ trustStatus: "trusted" })` that would miss a domain-trusted sender (#146).
 */
export async function effectiveTrustedSenders(store: Store): Promise<Sender[]> {
  const all = await store.senders.query({});
  if (all.length === 0) return all;
  const byKey = await domainRulesByKey(store);
  return all.filter(
    (s) =>
      effectiveSenderStatus(
        s,
        byKey.get(keyFor(s.domain)),
        parentDomainRuleFor(s.domain, byKey),
      ) === "trusted",
  );
}

/** A blocked domain plus the exception addresses to carve out of its block. */
export interface BlockedDomainTarget {
  domain: Domain;
  /** Exception addresses whose effective status is NOT blocked — carved out via negatedQuery. */
  excludeAddresses: string[];
  /**
   * The domain's observed senders whose effective status IS still blocked. Used only when the
   * carve-out overflows one filter's criteria budget and the compiler falls back to enumerating
   * them (#191).
   */
  blockedMemberAddresses: string[];
}

/**
 * The blocked domains, each with the exception addresses that must be excluded from its block
 * (`*@domain`) filter and existing-mail sweep — the exceptions the domain override no longer
 * blocks (a per-address trust). Without this, a blocked domain trashes its trusted exceptions
 * (#145).
 */
export async function effectiveBlockedDomains(store: Store): Promise<BlockedDomainTarget[]> {
  const domains = await store.domains.query({ trustStatus: "blocked" });
  const byKey = await domainRulesByKey(store);
  const targets: BlockedDomainTarget[] = [];
  for (const domain of domains) {
    // Members resolve against the parent rule too: a sender the parent trusts is not blocked
    // by this domain's rule, and must be carved out of the filter like any other exception.
    const parentRule = parentDomainRuleFor(domain.domain, byKey);
    const excludeAddresses: string[] = [];
    for (const email of domain.exceptionAddresses) {
      const sender = await store.senders.get(keyFor(email));
      if (sender !== undefined && effectiveSenderStatus(sender, domain, parentRule) !== "blocked") {
        excludeAddresses.push(email);
      }
    }
    // The members the block still covers — the enumerate fallback's input when the carve-out
    // grows past what one filter's criteria can hold (#191).
    const members = await store.senders.query({ domain: domain.domain });
    const blockedMemberAddresses = members
      .filter((sender) => effectiveSenderStatus(sender, domain, parentRule) === "blocked")
      .map((sender) => sender.email);
    targets.push({ domain, excludeAddresses, blockedMemberAddresses });
  }
  return targets;
}
