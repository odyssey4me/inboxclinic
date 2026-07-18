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

import { compileFilters, reconcileFilters } from "./compileFilters";
import { planActions } from "./planActions";
import { resolveEffectiveDecision } from "../decisions/resolveEffectiveDecision";
import { keyFor } from "../keys";
import type { GmailClient } from "../ports/GmailClient";
import type { BlockAction, Decision, DecisionScope, Sender, Store, TrustStatus } from "../store";

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
    if (decision.scope === "domain") domainStatus.set(decision.subjectId, next);
    else senderStatus.set(decision.subjectId, next);
  }

  // 1. Native filters — reconcile the *prospective* blocked set against Gmail's filters.
  let filtersToCreate = 0;
  let filtersToDelete = 0;
  try {
    // Effective blocked set: a sender whose (prospective) domain trusts it is not blocked,
    // so the preview matches what enforce would actually do (#144).
    const blockedSenders = senders.filter((s) => {
      const domain = domainByName.get(s.domain.toLowerCase());
      const addressStatus = senderStatus.get(s.id) ?? s.trustStatus;
      const domainStat = domain ? (domainStatus.get(domain.id) ?? domain.trustStatus) : "pending";
      return (
        resolveEffectiveDecision({
          addressStatus: addressStatus === "pending" ? null : addressStatus,
          addressIsException: domain?.exceptionAddresses.includes(s.email) ?? false,
          domainStatus: domainStat === "pending" ? null : domainStat,
          // A domain only gets a status via a domain-scope decision (stored or previewed),
          // so a non-pending prospective status is a domain-scope override.
          domainScope: domainStat === "pending" ? null : "domain",
        }).status === "blocked"
      );
    });
    const blockedDomains = domains
      .filter((d) => domainStatus.get(d.id) === "blocked")
      .map((d) => ({
        domain: d.domain,
        // Carve out exception addresses this (prospectively) blocked domain no longer blocks,
        // so the previewed filter set matches what enforce would create (#145).
        excludeAddresses: d.exceptionAddresses.filter((email) => {
          const s = senderById.get(keyFor(email));
          if (s === undefined) return false;
          const addr = senderStatus.get(s.id) ?? s.trustStatus;
          return (
            resolveEffectiveDecision({
              addressStatus: addr === "pending" ? null : addr,
              addressIsException: true,
              domainStatus: "blocked",
              domainScope: "domain",
            }).status !== "blocked"
          );
        }),
      }));
    const compiled = compileFilters(blockedSenders, blockedDomains);
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
  let messagesToRescue = 0;
  for (const decision of decisions) {
    if (decision.decision === "block") {
      const sender = decision.scope === "address" ? senderById.get(decision.subjectId) : undefined;
      const from =
        decision.scope === "domain"
          ? `*@${domainById.get(decision.subjectId)?.domain ?? ""}`
          : (sender?.email ?? "");
      if (from === "" || from === "*@") continue;
      const plan = planActions({
        decision: "block",
        actions: decision.actions ?? [],
        hasListUnsubscribe: sender?.hasListUnsubscribe ?? false,
      });
      if (plan.messageMutation !== null) {
        const ids = await client.listMessageIdsForSender(from);
        if (plan.messageMutation.addLabelIds?.includes("TRASH") === true) {
          messagesToDelete += ids.length;
        } else if (plan.messageMutation.removeLabelIds?.includes("INBOX") === true) {
          messagesToArchive += ids.length;
        }
      }
    } else if (decision.decision === "trust" && decision.scope === "address") {
      // Reversal to Trust rescues the sender's spam-marked mail. (Trash-scoped rescue
      // counting arrives with the Spam/Trash learning scan — Decision 7.)
      const sender = senderById.get(decision.subjectId);
      if (sender !== undefined && sender.spamMarkedCount > 0) {
        messagesToRescue += sender.spamMarkedCount;
      }
    }
  }

  return {
    filtersToCreate,
    filtersToDelete,
    messagesToArchive,
    messagesToDelete,
    messagesToRescue,
  };
}
