// SPDX-License-Identifier: Apache-2.0
/**
 * What a parent-domain rule would actually cover — design-trust-decisions.md Decision 9
 * point 6, the breadth warning.
 *
 * A parent rule is offered in terms of one registrable domain, but Gmail enforces it with a
 * coarse `from:` match that reaches further than that name suggests. Two groups come with it,
 * and they are not the same kind of thing:
 *
 * - **the subtree** — `news.example.com` under `example.com`: genuinely the same organisation,
 *   and exactly what the rule is for;
 * - **prefix-sharing siblings** — `apple.com.au` alongside `apple.com`: a *different*
 *   registrable domain that the match catches anyway, because Gmail matches dot-bounded labels
 *   from the left. Often a different company entirely.
 *
 * The second group is why a decision like this needs stating before it is made, not explaining
 * afterwards. This computes both from senders actually observed, so the warning lists real
 * addresses rather than hypotheticals — while being explicit that the match surface is not
 * enumerable in advance: a domain nobody has written from yet cannot appear here.
 *
 * Pure: senders in, groups out, no I/O.
 */

import { registrableDomain } from "./registrableDomain";

/** One observed domain a parent rule would reach, with how many of its senders were seen. */
export interface CoveredDomain {
  domain: string;
  senderCount: number;
}

export interface ParentDomainCoverage {
  /** The registrable domain the rule would be keyed on. */
  registrable: string;
  /** Observed domains genuinely under it — the subtree the rule is meant to cover. */
  subtree: CoveredDomain[];
  /**
   * Observed domains the coarse match also catches although they are a DIFFERENT registrable
   * domain (`apple.com.au` for `apple.com`). The surprising half of the breadth.
   */
  siblings: CoveredDomain[];
  /** Senders across both groups — what the warning counts. */
  senderCount: number;
}

/**
 * What a parent rule on this sender's registrable domain would cover, from observed senders.
 *
 * Returns `null` when no such rule can exist — a host with no registrable domain (a bare
 * public suffix, an IP, something unparseable) cannot be the subject of one.
 */
export function parentDomainCoverage(
  senderDomain: string,
  senders: ReadonlyArray<{ domain: string }>,
): ParentDomainCoverage | null {
  const registrable = registrableDomain(senderDomain);
  if (registrable === null) return null;

  const countsByDomain = new Map<string, number>();
  for (const sender of senders) {
    const domain = sender.domain.toLowerCase();
    countsByDomain.set(domain, (countsByDomain.get(domain) ?? 0) + 1);
  }

  const subtree: CoveredDomain[] = [];
  const siblings: CoveredDomain[] = [];
  for (const [domain, senderCount] of countsByDomain) {
    // Under the registrable domain: the name itself, or something beneath it. Confirmed with
    // the PSL rather than by string shape, so a lookalike can't slip in as a member.
    if (
      (domain === registrable || domain.endsWith(`.${registrable}`)) &&
      registrableDomain(domain) === registrable
    ) {
      subtree.push({ domain, senderCount });
      continue;
    }
    // Caught by the coarse match without being under it: the leading labels are the
    // registrable domain, but the whole host resolves elsewhere.
    if (domain.startsWith(`${registrable}.`)) siblings.push({ domain, senderCount });
  }

  const byDomain = (a: CoveredDomain, b: CoveredDomain): number => a.domain.localeCompare(b.domain);
  subtree.sort(byDomain);
  siblings.sort(byDomain);

  return {
    registrable,
    subtree,
    siblings,
    senderCount:
      subtree.reduce((total, d) => total + d.senderCount, 0) +
      siblings.reduce((total, d) => total + d.senderCount, 0),
  };
}
