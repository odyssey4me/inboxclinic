// SPDX-License-Identifier: Apache-2.0
/**
 * Count-only enforcement simulation — the impact preview (design-gmail-integration.md
 * Decision 8, design-trust-decisions.md Decision 7).
 *
 * Given a set of *prospective* decisions (staged in the workflow, or a change in the
 * Decisions view), count what `enforce` would do — filters created/removed, existing
 * mail archived/deleted, mail rescued — **without mutating anything**. It reuses the same
 * read paths as `enforce` (`listFilters`, `listMessageIdsForSender`) but calls no
 * mutating endpoint, so a preview never touches Gmail.
 */

import { compileFilters, exclusionTerms, reconcileFilters } from "./compileFilters";
import { withCurrentFilterForm } from "./filterForm";
import { planActions } from "./planActions";
import { coveringRulesFor, effectiveSenderStatus } from "../decisions/effectiveStatus";
import { registrableDomain } from "../domains/registrableDomain";
import { isSubdomainOf } from "../domains/subtree";
import { keyFor } from "../keys";
import type { GmailClient } from "../ports/GmailClient";
import type {
  BlockAction,
  Decision,
  DecisionScope,
  Domain,
  Sender,
  Store,
  TrustStatus,
} from "../store";

/** A not-yet-applied decision to preview. */
export interface PreviewDecision {
  /** Sender id for `address` scope; domain id for `domain` scope. */
  subjectId: string;
  scope: DecisionScope;
  decision: Decision;
  /** Block actions to stage (ignored for trust/defer). */
  actions?: BlockAction[];
}

/** The counted impact of applying + enforcing a set of prospective decisions. */
export interface SimulatedImpact {
  filtersToCreate: number;
  filtersToDelete: number;
  /** Existing messages that would be archived (removed from the inbox). */
  messagesToArchive: number;
  /** Existing messages that would be trashed (deleted; recoverable from Trash). */
  messagesToDelete: number;
  /** Existing messages that would be rescued from Spam/Trash (on a reversal to Trust). */
  messagesToRescue: number;
}

/**
 * Estimate how many messages a sender sends per week, from its last-30-day volume — used
 * to extrapolate the *going-forward* impact of a rule in the preview.
 */
export function estimateWeeklyVolume(sender: Pick<Sender, "recencyBuckets">): number {
  return Math.round((sender.recencyBuckets.d30 * 7) / 30);
}

/**
 * Count the impact of applying `decisions` on top of the current store state, without
 * mutating anything. Best-effort: a read failure yields zeroed filter counts rather than
 * throwing, so a preview degrades gracefully.
 */
export async function simulateEnforcement(
  client: GmailClient,
  store: Store,
  decisions: PreviewDecision[],
): Promise<SimulatedImpact> {
  const senders = await store.senders.query({});
  const domains = await store.domains.query({});
  const senderById = new Map(senders.map((s) => [s.id, s]));
  const domainById = new Map(domains.map((d) => [d.id, d]));
  const sendersByDomain = new Map<string, Sender[]>();
  for (const sender of senders) {
    const key = sender.domain.toLowerCase();
    sendersByDomain.set(key, [...(sendersByDomain.get(key) ?? []), sender]);
  }

  // Prospective trust status: current state with the previewed decisions applied.
  const senderStatus = new Map(senders.map((s) => [s.id, s.trustStatus]));
  const domainStatus = new Map(domains.map((d) => [d.id, d.trustStatus]));
  for (const decision of decisions) {
    // Defer never changes trust status: it's a no-op on an already-decided subject and only
    // decays a still-pending prompt (applyDecision.ts). Leave the seeded current status alone
    // rather than forcing it to "pending" — the latter overstated an already-decided subject
    // appearing to lose its override in the preview (#148).
    if (decision.decision === "defer") continue;
    const next: TrustStatus = decision.decision === "block" ? "blocked" : "trusted";
    // Any non-address scope decides a DOMAIN record — `parentDomain` included. Testing for
    // `"domain"` alone would file a parent decision against a sender id that doesn't exist,
    // so the rule would be invisible to the preview while plainly applying at Apply time.
    if (decision.scope !== "address") domainStatus.set(decision.subjectId, next);
    else senderStatus.set(decision.subjectId, next);
  }

  /** The prospective decision scope of a domain record — a previewed decision sets it. */
  const prospectiveScope = (domain: Domain): DecisionScope | null => {
    const previewed = decisions.find(
      (d) => d.subjectId === domain.id && d.scope !== "address" && d.decision !== "defer",
    );
    return previewed?.scope ?? domain.decisionScope;
  };

  // Exceptions this batch would record. `applyDecision` writes a narrower decision into every
  // broader rule covering it — the exact domain, the registrable domain's parent rule, and any
  // domain-scope block whose subtree the sender sits in (#244) — so the preview has to model
  // the same, or a "block the domain, keep this one" batch previews the opposite of what
  // applying it does (#161). Defer is excluded: it leaves the subject undecided and records no
  // exception at all (#195). Keyed by domain key, as `broaderRulesFor` resolves them.
  const batchExceptionsByDomain = new Map<string, string[]>();
  const addException = (domainName: string, email: string): void => {
    const key = keyFor(domainName);
    batchExceptionsByDomain.set(key, [...(batchExceptionsByDomain.get(key) ?? []), email]);
  };
  // Subdomains this batch would carve out of a parent-domain rule, as `applyDomainDecision` does.
  const batchExceptionDomains = new Map<string, string[]>();

  /**
   * Every domain record with this batch's effects folded in — prospective status, scope and
   * exception lists. Built once and fed to the same `coveringRulesFor`/`effectiveSenderStatus`
   * the Apply path uses, rather than re-deriving the ladder here: every consumer that
   * re-derived it inline drifted, and each place that forgot a level silently disagreed with
   * Apply.
   */
  const prospectiveDomainsByKey = new Map<string, Domain>();
  const refreshProspectiveDomains = (): void => {
    prospectiveDomainsByKey.clear();
    for (const domain of domains) {
      const key = keyFor(domain.domain);
      prospectiveDomainsByKey.set(key, {
        ...domain,
        trustStatus: domainStatus.get(domain.id) ?? domain.trustStatus,
        decisionScope: prospectiveScope(domain),
        exceptionAddresses: [
          ...domain.exceptionAddresses,
          ...(batchExceptionsByDomain.get(key) ?? []),
        ],
        exceptionDomains: [...domain.exceptionDomains, ...(batchExceptionDomains.get(key) ?? [])],
      });
    }
  };
  // Seeded without the batch's exceptions so `broaderRulesFor`'s inputs — the prospective
  // statuses and scopes — are in place before the exceptions those rules receive are resolved.
  refreshProspectiveDomains();

  for (const decision of decisions) {
    if (decision.decision === "defer") continue;
    if (decision.scope === "address") {
      const sender = senderById.get(decision.subjectId);
      if (sender === undefined) continue;
      const exact = prospectiveDomainsByKey.get(keyFor(sender.domain));
      if (exact?.decisionScope === "domain" || exact?.decisionScope === "parentDomain") {
        addException(exact.domain, sender.email);
      }
      for (const rule of coveringRulesFor(sender.domain, prospectiveDomainsByKey)) {
        addException(rule.domain, sender.email);
      }
    } else if (decision.scope === "domain") {
      // A domain decision under a distinct parent-domain rule carves that subdomain out of it.
      const domain = domainById.get(decision.subjectId);
      if (domain === undefined) continue;
      const registrable = registrableDomain(domain.domain);
      if (registrable === null || keyFor(registrable) === keyFor(domain.domain)) continue;
      const parent = prospectiveDomainsByKey.get(keyFor(registrable));
      if (parent?.decisionScope !== "parentDomain") continue;
      const key = keyFor(parent.domain);
      batchExceptionDomains.set(key, [...(batchExceptionDomains.get(key) ?? []), domain.domain]);
    }
  }
  refreshProspectiveDomains();

  /**
   * A sender's effective status under the previewed decisions — the whole ladder, resolved by
   * the same helper Apply uses, over the prospective records.
   */
  const prospectiveStatusOf = (sender: Sender): TrustStatus =>
    effectiveSenderStatus(
      { email: sender.email, trustStatus: senderStatus.get(sender.id) ?? sender.trustStatus },
      prospectiveDomainsByKey.get(keyFor(sender.domain)),
      coveringRulesFor(sender.domain, prospectiveDomainsByKey),
    );

  // A (prospectively) blocked domain's trusted exception addresses — the ones whose effective
  // status is no longer blocked. Excluded from both the domain's `*@domain` filter (#145) and
  // its existing-mail sweep (#151), so the preview matches what enforce actually does. The
  // exception set is the PROSPECTIVE one — stored exceptions plus any this batch would add
  // (#161) — and it can hold addresses at the block's SUBDOMAINS, not only at the domain
  // itself, since the block covers the subtree (#244).
  const prospectiveDomainExclusions = (domain: Domain): string[] => {
    const prospective = prospectiveDomainsByKey.get(keyFor(domain.domain));
    const seen = new Set<string>();
    const exceptions: string[] = [];
    for (const email of prospective?.exceptionAddresses ?? domain.exceptionAddresses) {
      const key = keyFor(email);
      if (seen.has(key)) continue;
      seen.add(key);
      exceptions.push(email);
    }
    return exceptions.filter((email) => {
      const s = senderById.get(keyFor(email));
      return s !== undefined && prospectiveStatusOf(s) !== "blocked";
    });
  };

  /** The senders a parent-domain decision covers — the whole subtree, by registrable domain. */
  const subtreeMembers = (domain: Domain): Sender[] =>
    senders.filter((s) => registrableDomain(s.domain) === domain.domain.toLowerCase());

  /**
   * Subdomains under a (prospectively) blocked domain that the user has separately decided to
   * TRUST — carved out of both its filter and its sweep, mirroring `effectiveBlockedDomains`.
   *
   * A domain block spans the subtree (#210), so without this the preview would count mail the
   * apply is going to spare, and overstate the block by exactly the subdomains the user
   * protected. Reads the prospective status, so a subdomain trusted earlier in this same batch
   * already counts as decided.
   */
  const prospectiveSubdomainExclusions = (domain: Domain): string[] =>
    domains
      .filter(
        (d) =>
          isSubdomainOf(d.domain, domain.domain) &&
          (domainStatus.get(d.id) ?? d.trustStatus) === "trusted",
      )
      .map((d) => d.domain)
      .sort();

  // 1. Native filters — reconcile the *prospective* blocked set against Gmail's filters.
  let filtersToCreate = 0;
  let filtersToDelete = 0;
  try {
    // Effective blocked set: a sender whose (prospective) domain trusts it is not blocked,
    // so the preview matches what enforce would actually do (#144).
    const blockedSenders = senders.filter((s) => prospectiveStatusOf(s) === "blocked");
    const blockedDomains = domains
      .filter((d) => domainStatus.get(d.id) === "blocked")
      .map((d) => {
        const excludeAddresses = prospectiveDomainExclusions(d);
        const excluded = new Set(excludeAddresses.map((email) => keyFor(email)));
        return {
          domain: d.domain,
          // Carve out exception addresses this (prospectively) blocked domain no longer blocks,
          // so the previewed filter set matches what enforce would create (#145).
          excludeAddresses,
          // ...and the subdomains it no longer blocks either (#210).
          excludeSubdomains: prospectiveSubdomainExclusions(d),
          // The members the block still covers, so an overflowing carve-out previews the same
          // enumerate fallback enforce would compile (#191).
          blockedMemberAddresses: (sendersByDomain.get(d.domain.toLowerCase()) ?? [])
            .filter((s) => !excluded.has(s.id))
            .map((s) => s.email),
        };
      });
    // Same filter-form input as enforce, so the previewed filter counts match what an
    // apply would actually do to a domain sitting on the criteria budget (#208).
    const compiled = compileFilters(
      blockedSenders,
      blockedDomains,
      await withCurrentFilterForm(store),
    );
    const existing = await client.listFilters();
    const managedFilterIds = new Set((await store.filterSync.get())?.managedFilterIds ?? []);
    const plan = reconcileFilters(compiled.filters, existing, managedFilterIds);
    filtersToCreate = plan.toCreate.length;
    filtersToDelete = plan.toDelete.length;
  } catch {
    // A read failure leaves filter counts at zero; the preview still shows message impact.
  }

  // 2. Existing-mail actions for the previewed decisions.
  let messagesToArchive = 0;
  let messagesToDelete = 0;
  // Senders a trust in this batch would rescue, collected as ids so a sender covered by both
  // an address and a domain decision is only counted once.
  const rescueSenderIds = new Set<string>();
  for (const decision of decisions) {
    if (decision.decision === "block") {
      // Any non-address scope decides a DOMAIN record, and enforce sweeps it as `*@domain`
      // whatever its scope — `effectiveBlockedDomains` selects on trustStatus, not scope. A
      // `=== "domain"` test here left a parent block resolving to an empty subject, so the
      // preview reported no swept mail for a decision that sweeps plenty.
      const sender = decision.scope === "address" ? senderById.get(decision.subjectId) : undefined;
      const domain = decision.scope !== "address" ? domainById.get(decision.subjectId) : undefined;
      const from =
        decision.scope !== "address" ? `*@${domain?.domain ?? ""}` : (sender?.email ?? "");
      if (from === "" || from === "*@") continue;
      const plan = planActions({
        decision: "block",
        actions: decision.actions ?? [],
        hasListUnsubscribe: sender?.hasListUnsubscribe ?? false,
      });
      if (plan.messageMutation !== null) {
        // Exclude the domain's trusted exception addresses from the estimate, matching enforce's
        // sweep — otherwise a domain block overstates its existing-mail count (#151).
        const terms = domain
          ? exclusionTerms({
              excludeAddresses: prospectiveDomainExclusions(domain),
              excludeSubdomains: prospectiveSubdomainExclusions(domain),
            })
          : [];
        const excludeFrom = terms.length > 0 ? terms.join(" OR ") : undefined;
        const ids = await client.listMessageIdsForSender(from, undefined, excludeFrom);
        if (plan.messageMutation.addLabelIds?.includes("TRASH") === true) {
          messagesToDelete += ids.length;
        } else if (plan.messageMutation.removeLabelIds?.includes("INBOX") === true) {
          messagesToArchive += ids.length;
        }
      }
    } else if (decision.decision === "trust") {
      // Reversal to Trust rescues spam-marked mail. (Trash-scoped rescue counting arrives
      // with the Spam/Trash learning scan — Decision 7.) A domain-scope trust rescues every
      // member it makes effectively trusted, matching enforce's `effectiveTrustedSenders`
      // sweep (#146) — the estimate previously counted only address-scope trust, so trusting
      // a domain understated the rescue (#192).
      if (decision.scope === "address") {
        const sender = senderById.get(decision.subjectId);
        if (sender !== undefined) rescueSenderIds.add(sender.id);
      } else {
        const domain = domainById.get(decision.subjectId);
        if (domain !== undefined) {
          if (decision.scope === "parentDomain") {
            // Subtree members resolve through the full ladder: their own exact-domain record
            // may say anything, and the parent rule this batch creates is what covers them.
            // An exact-name member lookup would find none of them.
            for (const sender of subtreeMembers(domain)) {
              if (prospectiveStatusOf(sender) === "trusted") rescueSenderIds.add(sender.id);
            }
          } else {
            // An exception address keeps its own address decision, so a member the batch blocks
            // in the same breath is not swept up by the domain trust — the same resolution
            // `effectiveTrustedSenders` performs at Apply time (#146).
            for (const sender of sendersByDomain.get(domain.domain.toLowerCase()) ?? []) {
              if (prospectiveStatusOf(sender) === "trusted") rescueSenderIds.add(sender.id);
            }
          }
        }
      }
    }
  }

  let messagesToRescue = 0;
  for (const id of rescueSenderIds) {
    messagesToRescue += senderById.get(id)?.spamMarkedCount ?? 0;
  }

  return {
    filtersToCreate,
    filtersToDelete,
    messagesToArchive,
    messagesToDelete,
    messagesToRescue,
  };
}
