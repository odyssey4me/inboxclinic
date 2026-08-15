// SPDX-License-Identifier: Apache-2.0
/**
 * Effective-status helpers for enforcement — resolve the domain-override + exception rule
 * (design-trust-decisions.md Decision 2) so enforcement acts on the *effective* decision,
 * not raw `trustStatus`. Reading raw status keeps a Gmail block filter alive for a sender the
 * user has since trusted at the domain level (#144). Mirrors what `generatePrompts` (#123) and
 * the Dashboard already do; the enforcement path was the outlier still reading raw status.
 */

import { registrableDomain } from "../domains/registrableDomain";
import { inDomainSubtree, isSubdomainOf } from "../domains/subtree";
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

/** How many dot-separated labels a host has — the depth that orders ancestors by nearness. */
const labelCount = (host: string): number => host.split(".").length;

/**
 * Every rule that covers `senderDomain` **from above**, nearest ancestor first.
 *
 * Two kinds of record reach into a subtree, and a sender can sit under both:
 *
 * - a **parent-domain rule** on the registrable domain (Decision 9), which spans the subtree
 *   by design; and
 * - a **domain-scope block**, which spans it by consequence — `*@domain` is not an exact
 *   match, so its filter and its sweep act on everything beneath it (#210, measured). A
 *   domain-scope *trust* is deliberately not included: it compiles to no rule at all, so it
 *   has no reach to model, and treating it as covering the subtree would have trust-rescue
 *   pull subtree mail out of Trash on no evidence.
 *
 * Sorted by label depth so the **nearest** rule is considered first — most-specific-wins,
 * the same ordering `SCOPE_SPECIFICITY` encodes across scopes.
 */
export function coveringRulesFor(
  senderDomain: string,
  domainsByKey: ReadonlyMap<string, DomainRule>,
): DomainRule[] {
  const rules: DomainRule[] = [];
  const parentRule = parentDomainRuleFor(senderDomain, domainsByKey);
  if (parentRule !== undefined) rules.push(parentRule);
  for (const candidate of domainsByKey.values()) {
    if (
      candidate.decisionScope === "domain" &&
      candidate.trustStatus === "blocked" &&
      isSubdomainOf(senderDomain, candidate.domain)
    ) {
      rules.push(candidate);
    }
  }
  return rules.sort((a, b) => labelCount(b.domain) - labelCount(a.domain));
}

/**
 * The effective trust status of a sender, resolving the rules covering it from above, the
 * exact-domain override, and address exceptions (design-trust-decisions.md Decisions 2 and 9).
 *
 * `coveringRules` come from `coveringRulesFor`, nearest first. The applicable one is the
 * nearest the sender is **not** carved out of: a user who is excepted from a subdomain's block
 * is still covered by a separate block on the domain above it, and resolving only the nearest
 * would report that sender as trusted while the broader filter went on trashing its mail.
 */
export function effectiveSenderStatus(
  sender: Pick<Sender, "email" | "trustStatus">,
  domain: DomainRule | undefined,
  coveringRules: readonly DomainRule[] = [],
): TrustStatus {
  // A covering rule steps aside when this sender, or its exact domain, is carved out of it.
  const isExcepted = (rule: DomainRule): boolean =>
    rule.exceptionAddresses.includes(sender.email) ||
    (domain !== undefined &&
      (rule.exceptionDomains.includes(domain.domain) ||
        // A domain-scope block also steps aside for a subdomain the user separately decided to
        // TRUST — nothing records that as an `exceptionDomains` entry, but enforcement carves
        // it out of the block all the same, as a `*@sub.domain` term (#210). Resolving it any
        // other way would have the status disagree with the filter and the sweep.
        (rule.decisionScope === "domain" &&
          domain.trustStatus === "trusted" &&
          isSubdomainOf(domain.domain, rule.domain))));

  // The nearest rule that still claims this sender; failing that the nearest one, so a sender
  // excepted from every rule resolves exactly as it did when there was only ever one.
  const applicable = coveringRules.find((rule) => !isExcepted(rule)) ?? coveringRules[0];

  return resolveEffectiveDecision({
    addressStatus: nonPending(sender.trustStatus),
    addressIsException: domain?.exceptionAddresses.includes(sender.email) ?? false,
    domainStatus: domain ? nonPending(domain.trustStatus) : null,
    domainScope: domain?.decisionScope ?? null,
    parentDomainStatus: applicable ? nonPending(applicable.trustStatus) : null,
    parentDomainIsException: applicable !== undefined && isExcepted(applicable),
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
      effectiveSenderStatus(s, byKey.get(keyFor(s.domain)), coveringRulesFor(s.domain, byKey)) ===
      "blocked",
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
      effectiveSenderStatus(s, byKey.get(keyFor(s.domain)), coveringRulesFor(s.domain, byKey)) ===
      "trusted",
  );
}

/** A blocked domain plus the exception addresses to carve out of its block. */
export interface BlockedDomainTarget {
  domain: Domain;
  /** Exception addresses whose effective status is NOT blocked — carved out via negatedQuery. */
  excludeAddresses: string[];
  /**
   * Subdomains under this block that the user has **separately decided to trust**, carved out
   * as `*@sub.domain` terms.
   *
   * A domain block covers the subtree, because that is what Gmail's `*@domain` matches (#210).
   * Without this, an explicit trust decision on `email.monzo.com` would not save its mail from
   * a `monzo.com` block — the sharpest form of that bug, since the user made the decision and
   * watched it be ignored. Sorted, because these terms end up in filter criteria whose exact
   * string the reconcile signature compares.
   */
  excludeSubdomains: string[];
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
  if (domains.length === 0) return [];
  const byKey = await domainRulesByKey(store);
  // Every target needs the senders in the subtree beneath it, and each sender's status is the
  // same answer whichever target is asking — so load once and resolve once, rather than a query
  // and a ladder walk per domain per sender.
  const senders = await store.senders.query({});
  const senderById = new Map(senders.map((sender) => [sender.id, sender]));
  // Resolve each sender against its OWN records — its exact-domain record and every rule
  // covering it. A sender under a block is not necessarily AT the blocked domain: a block
  // covers its subtree, so resolving against the blocked domain as if it were the sender's
  // exact domain would read the wrong record's status, scope and exception list (#244).
  const blockedSenders = senders.filter(
    (sender) =>
      effectiveSenderStatus(
        sender,
        byKey.get(keyFor(sender.domain)),
        coveringRulesFor(sender.domain, byKey),
      ) === "blocked",
  );
  const blockedSenderIds = new Set(blockedSenders.map((sender) => sender.id));

  const targets: BlockedDomainTarget[] = [];
  for (const domain of domains) {
    const excludeAddresses: string[] = [];
    for (const email of domain.exceptionAddresses) {
      const sender = senderById.get(keyFor(email));
      // An exception is no longer necessarily an address at this domain either — a sender
      // trusted at a subdomain records its carve-out on the block covering it (#244).
      if (sender !== undefined && !blockedSenderIds.has(sender.id)) excludeAddresses.push(email);
    }
    // A domain block reaches the whole subtree (#210), so it also covers subdomains that are
    // their own `Domain` records carrying their own decisions. Carve out the ones the user has
    // separately decided to TRUST. A `pending` subdomain is deliberately NOT carved out: no
    // decision has been made about it, so the block covers it — a breadth that is stated at
    // decision time rather than discovered afterwards. A `blocked` subdomain needs no
    // carve-out, being blocked either way.
    const excludeSubdomains = [...byKey.values()]
      .filter(
        (candidate) =>
          isSubdomainOf(candidate.domain, domain.domain) && candidate.trustStatus === "trusted",
      )
      .map((candidate) => candidate.domain)
      .sort();
    // The members the block still covers — the enumerate fallback's input when the carve-out
    // grows past what one filter's criteria can hold (#191).
    //
    // The whole SUBTREE, not an exact-name match, because that is what the block covers (#210).
    // An exact-name query listed only the apex senders, so an overflowing domain compiled to a
    // filter set that blocked none of its subdomains' mail going forward — while the sweep,
    // which stays `*@domain` whatever form the filter takes, went on trashing that same mail.
    // The block looked like it was working and had stopped (#249).
    const blockedMemberAddresses = blockedSenders
      .filter((sender) => inDomainSubtree(sender.domain, domain.domain))
      .map((sender) => sender.email);
    targets.push({ domain, excludeAddresses, excludeSubdomains, blockedMemberAddresses });
  }
  return targets;
}
