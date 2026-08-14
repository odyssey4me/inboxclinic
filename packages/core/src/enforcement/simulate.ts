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
import { resolveEffectiveDecision } from "../decisions/resolveEffectiveDecision";
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
  const domainByName = new Map(domains.map((d) => [d.domain.toLowerCase(), d]));
  const domainByKey = new Map(domains.map((d) => [d.id, d]));
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

  // Addresses this batch's own address-scope decisions would record as exceptions on their
  // domain: applyDecision.ts adds a sender to `exceptionAddresses` on any non-no-op address
  // decision under a domain-scoped domain (#161). Keyed by lowercased domain. Defer is excluded —
  // it leaves the subject undecided and records no exception at all (#195).
  const batchExceptionsByDomain = new Map<string, string[]>();
  for (const decision of decisions) {
    if (decision.scope !== "address" || decision.decision === "defer") continue;
    const sender = senderById.get(decision.subjectId);
    if (sender === undefined) continue;
    const key = sender.domain.toLowerCase();
    batchExceptionsByDomain.set(key, [...(batchExceptionsByDomain.get(key) ?? []), sender.email]);
  }

  // Exceptions this batch would record on ANY broader rule. `applyDecision` writes a narrower
  // decision into every broader rule covering it — the exact domain AND the registrable
  // domain's parent rule — so the preview has to model the same, or a "block the parent, keep
  // this one" batch previews the opposite of what applying it does.
  const batchAddressExceptionIds = new Set<string>();
  const batchDomainExceptionNames = new Set<string>();
  for (const decision of decisions) {
    if (decision.decision === "defer") continue;
    if (decision.scope === "address") batchAddressExceptionIds.add(decision.subjectId);
    else if (decision.scope === "domain") {
      const domain = domainById.get(decision.subjectId);
      if (domain !== undefined) batchDomainExceptionNames.add(domain.domain.toLowerCase());
    }
  }

  /** The prospective decision scope of a domain record — a previewed decision sets it. */
  const prospectiveScope = (domain: Domain): DecisionScope | null => {
    const previewed = decisions.find(
      (d) => d.subjectId === domain.id && d.scope !== "address" && d.decision !== "defer",
    );
    return previewed?.scope ?? domain.decisionScope;
  };

  /**
   * The parent-domain rule covering a sender, under PROSPECTIVE scope — so a rule this batch
   * is about to create counts, exactly as it will once applied.
   */
  const parentRuleFor = (senderDomain: string): Domain | undefined => {
    const registrable = registrableDomain(senderDomain);
    if (registrable === null || keyFor(registrable) === keyFor(senderDomain)) return undefined;
    const rule = domainByKey.get(keyFor(registrable));
    return rule !== undefined && prospectiveScope(rule) === "parentDomain" ? rule : undefined;
  };

  /** The parent-rule half of a resolver input, prospective statuses and exceptions included. */
  const parentFields = (
    sender: Sender,
  ): { parentDomainStatus: TrustStatus | null; parentDomainIsException: boolean } => {
    const parent = parentRuleFor(sender.domain);
    if (parent === undefined) return { parentDomainStatus: null, parentDomainIsException: false };
    const status = domainStatus.get(parent.id) ?? parent.trustStatus;
    const senderDomain = sender.domain.toLowerCase();
    return {
      parentDomainStatus: status === "pending" ? null : status,
      parentDomainIsException:
        parent.exceptionAddresses.some((email) => keyFor(email) === sender.id) ||
        batchAddressExceptionIds.has(sender.id) ||
        parent.exceptionDomains.some((name) => name.toLowerCase() === senderDomain) ||
        batchDomainExceptionNames.has(senderDomain),
    };
  };

  // A (prospectively) blocked domain's trusted exception addresses — the ones whose effective
  // status is no longer blocked. Excluded from both the domain's `*@domain` filter (#145) and
  // its existing-mail sweep (#151), so the preview matches what enforce actually does.
  // Only ever called on a domain that is (prospectively) blocked; a blocked domain is always
  // domain-scoped (applyDecision.ts writes `decisionScope: "domain"` with the block), so the
  // `domainStatus/domainScope` here are that known state rather than re-derived per call. The
  // exception set is the PROSPECTIVE one — stored exceptions plus any this batch would add (#161).
  const prospectiveDomainExclusions = (domain: Domain): string[] => {
    const seen = new Set<string>();
    const exceptions: string[] = [];
    const batch = batchExceptionsByDomain.get(domain.domain.toLowerCase()) ?? [];
    for (const email of [...domain.exceptionAddresses, ...batch]) {
      const key = keyFor(email);
      if (seen.has(key)) continue;
      seen.add(key);
      exceptions.push(email);
    }
    return exceptions.filter((email) => {
      const s = senderById.get(keyFor(email));
      if (s === undefined) return false;
      const addr = senderStatus.get(s.id) ?? s.trustStatus;
      return (
        resolveEffectiveDecision({
          addressStatus: addr === "pending" ? null : addr,
          addressIsException: true,
          domainStatus: "blocked",
          domainScope: "domain",
          ...parentFields(s),
        }).status !== "blocked"
      );
    });
  };

  // Whether a (prospectively) trusted domain's member ends up effectively trusted — the same
  // resolution `effectiveTrustedSenders` performs at Apply time (#146). An exception address
  // keeps its own address decision, so a member the batch blocks in the same breath is not
  // swept up by the domain trust. Only ever called on a domain the batch trusts at domain
  // scope, so `domainStatus/domainScope` are that known state rather than re-derived.
  const prospectivelyTrustedMember = (sender: Sender, domain: Domain): boolean => {
    const batch = batchExceptionsByDomain.get(domain.domain.toLowerCase()) ?? [];
    const isException = [...domain.exceptionAddresses, ...batch].some(
      (email) => keyFor(email) === sender.id,
    );
    const addressStatus = senderStatus.get(sender.id) ?? sender.trustStatus;
    return (
      resolveEffectiveDecision({
        addressStatus: addressStatus === "pending" ? null : addressStatus,
        addressIsException: isException,
        domainStatus: "trusted",
        domainScope: "domain",
        ...parentFields(sender),
      }).status === "trusted"
    );
  };

  /**
   * A sender's effective status under the previewed decisions — the whole ladder, resolved
   * once. Extracted because every consumer that re-derived it inline drifted: each had to
   * remember the parent half, and each place that forgot silently disagreed with Apply.
   */
  const prospectiveStatusOf = (sender: Sender): TrustStatus => {
    const domain = domainByName.get(sender.domain.toLowerCase());
    const addressStatus = senderStatus.get(sender.id) ?? sender.trustStatus;
    const domainStat = domain ? (domainStatus.get(domain.id) ?? domain.trustStatus) : "pending";
    return resolveEffectiveDecision({
      addressStatus: addressStatus === "pending" ? null : addressStatus,
      addressIsException: domain?.exceptionAddresses.includes(sender.email) ?? false,
      domainStatus: domainStat === "pending" ? null : domainStat,
      // The real prospective scope (stored or previewed) rather than an assumed `"domain"` —
      // a domain that IS its own registrable domain can carry the rule at `"parentDomain"`
      // scope instead, and resolveEffectiveDecision only overrides an already-decided address
      // for the scope it actually sees (#222).
      domainScope:
        domainStat === "pending" || domain === undefined ? null : prospectiveScope(domain),
      ...parentFields(sender),
    }).status;
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
            for (const sender of sendersByDomain.get(domain.domain.toLowerCase()) ?? []) {
              if (prospectivelyTrustedMember(sender, domain)) rescueSenderIds.add(sender.id);
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
