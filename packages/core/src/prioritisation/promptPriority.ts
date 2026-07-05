// SPDX-License-Identifier: Apache-2.0
/**
 * `prioritisePrompts` — pure prompt prioritisation (no I/O).
 *
 * See docs/design-trust-decisions.md ("Prompt priority"):
 *
 *   Priority = Impact×0.4 + Confidence×0.3 + Batch×0.2 + Alignment×0.1   (scaled to 0–100)
 *
 * with the component sub-formulas (and caps) defined there. Batch grouping is by
 * domain; alignment leans on the user's past block behaviour (neutral 0.5 with no
 * history). `now` is injected for determinism — the function never reads the clock.
 */

import { keyFor } from "../keys";
import { ageInDays } from "../senders/recency";
import type { PriorityComponents, SenderCategory } from "../store/types";
import type { SenderSnapshot } from "../scoring/senderSnapshot";

export interface PrioritisedPrompt {
  senderId: string;
  priorityScore: number;
  components: PriorityComponents;
  batchGroupId: string | null;
  batchSize: number;
}

/** The user's past block behaviour, used by the Alignment component. */
export interface UserDecisionHistory {
  blockRateForCategory(category: SenderCategory): number;
  blockRateForTld(tld: string): number;
  blockRateForReadBand(readRate: number | null): number;
  hasDecisions: boolean;
}

/** A history with no recorded decisions → Alignment returns the neutral 0.5. */
export function emptyDecisionHistory(): UserDecisionHistory {
  return {
    blockRateForCategory: () => 0,
    blockRateForTld: () => 0,
    blockRateForReadBand: () => 0,
    hasDecisions: false,
  };
}

const FREQUENCY_IMPACT: Record<SenderSnapshot["frequency"], number> = {
  daily: 0.3,
  weekly: 0.2,
  monthly: 0.1,
  rare: 0.05,
};

function tldOf(domain: string): string {
  const parts = domain.split(".");
  return parts[parts.length - 1] ?? domain;
}

function impact(sender: SenderSnapshot, now: number): number {
  const volume = Math.min(sender.totalEmails / 100, 1) * 0.5;
  const frequency = FREQUENCY_IMPACT[sender.frequency];
  const ageDays = ageInDays(now, sender.lastEmailAt);
  const recency = ageDays <= 30 ? 0.2 : ageDays <= 90 ? 0.1 : 0;
  return volume + frequency + recency;
}

function confidence(sender: SenderSnapshot): number {
  const readTerm = sender.readRate === null ? 0 : Math.abs(sender.readRate - 0.5) * 2 * 0.4;
  const listUnsub = sender.hasListUnsubscribe ? 0.2 : 0;
  const historyLen = Math.min(sender.totalEmails / 50, 1) * 0.2;
  const categoryConsistency = sender.category === "other" ? 0 : 0.2;
  return readTerm + listUnsub + historyLen + categoryConsistency;
}

function batch(sameDomainCount: number, batchTotalEmails: number): number {
  const domainGrouping =
    sameDomainCount >= 5 ? 0.6 : sameDomainCount >= 3 ? 0.4 : sameDomainCount >= 2 ? 0.2 : 0;
  const combinedVolume = Math.min(batchTotalEmails / 200, 1) * 0.4;
  return domainGrouping + combinedVolume;
}

function alignment(sender: SenderSnapshot, history: UserDecisionHistory): number {
  if (!history.hasDecisions) return 0.5;
  return (
    history.blockRateForCategory(sender.category) * 0.5 +
    history.blockRateForTld(tldOf(sender.domain)) * 0.3 +
    history.blockRateForReadBand(sender.readRate) * 0.2
  );
}

/** Pure. Sorts candidates by priority (desc), attaching domain batch grouping. */
export function prioritisePrompts(
  candidates: SenderSnapshot[],
  history: UserDecisionHistory,
  now: number,
): PrioritisedPrompt[] {
  const domainCount = new Map<string, number>();
  const domainVolume = new Map<string, number>();
  for (const sender of candidates) {
    domainCount.set(sender.domain, (domainCount.get(sender.domain) ?? 0) + 1);
    domainVolume.set(sender.domain, (domainVolume.get(sender.domain) ?? 0) + sender.totalEmails);
  }

  const prompts = candidates.map((sender) => {
    const sameDomainCount = domainCount.get(sender.domain) ?? 1;
    const batchTotalEmails = domainVolume.get(sender.domain) ?? sender.totalEmails;

    const components: PriorityComponents = {
      impact: impact(sender, now),
      confidence: confidence(sender),
      batch: batch(sameDomainCount, batchTotalEmails),
      alignment: alignment(sender, history),
    };

    const priorityScore =
      (components.impact * 0.4 +
        components.confidence * 0.3 +
        components.batch * 0.2 +
        components.alignment * 0.1) *
      100;

    return {
      senderId: keyFor(sender.email),
      priorityScore,
      components,
      batchGroupId: sameDomainCount >= 2 ? `domain:${sender.domain}` : null,
      batchSize: sameDomainCount,
    };
  });

  return prompts.sort((a, b) => b.priorityScore - a.priorityScore);
}
