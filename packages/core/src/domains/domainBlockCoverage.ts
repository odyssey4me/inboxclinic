// SPDX-License-Identifier: Apache-2.0
/**
 * What an ordinary **domain-scope** decision would actually cover — the breadth statement for
 * a plain domain block (design-gmail-integration.md Decision 5 point 9, #210).
 *
 * The decision is offered as "whole domain (example.com)", but Gmail's `*@example.com` matches
 * the domain **and everything under it**. Measured on a real account: `from:*@google.com`
 * returned `docs.`, `accounts.` and `plus.google.com` alongside 116 apex senders. So the
 * decision reaches senders the user never named — each tracked here as its own `Domain` record
 * with its own trust status — and until #210 nothing said so. Enforcement was corrected first;
 * this is the other half, stating the breadth *before* the decision rather than explaining it
 * afterwards.
 *
 * Deliberately **narrower than `parentDomainCoverage`**, which also reports prefix-sharing
 * siblings (`apple.com.au` under `apple.com`). That breadth is evidence about the **bare**
 * `from:<domain>` criterion a parent rule compiles to (#181). The `*@domain` form measured in
 * #210 spanned the subtree only, so listing siblings here would assert a reach nothing has
 * shown — and a warning that overstates is one users learn to skip.
 *
 * The reach is **not enumerable in advance**: a subdomain nobody has written from yet cannot
 * appear here, and is covered anyway. Callers should say so alongside the list.
 *
 * Pure: senders in, groups out, no I/O.
 */

import type { CoveredDomain } from "./parentDomainCoverage";
import { inDomainSubtree, isSubdomainOf } from "./subtree";

export interface DomainBlockCoverage {
  /** The domain the decision is keyed on. */
  domain: string;
  /**
   * Observed domains the decision would act on — the domain itself first, then the subdomains
   * it reaches, busiest first. Excludes anything already carved out.
   */
  covered: CoveredDomain[];
  /**
   * Observed subdomains the user has **separately decided**, which enforcement carves out of
   * the block (#210). Listed so the statement is "this covers X and Y, but not Z — you decided
   * Z" rather than silently omitting them.
   */
  carvedOut: CoveredDomain[];
  /** Senders across `covered` — what the decision would actually act on. */
  senderCount: number;
}

/** Order: the domain itself first (it is the subject), then busiest subdomain, then by name. */
function byProminence(domain: string) {
  return (a: CoveredDomain, b: CoveredDomain): number => {
    if (a.domain === domain) return -1;
    if (b.domain === domain) return 1;
    return b.senderCount - a.senderCount || a.domain.localeCompare(b.domain);
  };
}

/**
 * What a domain-scope decision on `domain` would cover, from observed senders.
 *
 * `decidedSubdomains` are the subdomains carrying their own decision that enforcement will
 * carve out — pass the ones whose status is not blocked, matching `effectiveBlockedDomains`.
 * A carve-out takes its own subtree with it, because the `*@sub` exclusion term does.
 */
export function domainBlockCoverage(
  domain: string,
  senders: ReadonlyArray<{ domain: string }>,
  decidedSubdomains: ReadonlyArray<string> = [],
): DomainBlockCoverage {
  const subject = domain.trim().toLowerCase();
  const carvedOutNames = decidedSubdomains
    .map((d) => d.trim().toLowerCase())
    .filter((d) => isSubdomainOf(d, subject));

  const countsByDomain = new Map<string, number>();
  for (const sender of senders) {
    const host = sender.domain.trim().toLowerCase();
    if (!inDomainSubtree(host, subject)) continue;
    countsByDomain.set(host, (countsByDomain.get(host) ?? 0) + 1);
  }

  const covered: CoveredDomain[] = [];
  const carvedOut: CoveredDomain[] = [];
  for (const [host, senderCount] of countsByDomain) {
    // A carve-out excludes the excluded subdomain's OWN subtree too — `-from:(*@sub)` spans it,
    // so a host below a carved-out subdomain is spared along with it.
    const spared = carvedOutNames.some((name) => inDomainSubtree(host, name));
    (spared ? carvedOut : covered).push({ domain: host, senderCount });
  }
  covered.sort(byProminence(subject));
  carvedOut.sort(byProminence(subject));

  return {
    domain: subject,
    covered,
    carvedOut,
    senderCount: covered.reduce((total, d) => total + d.senderCount, 0),
  };
}
