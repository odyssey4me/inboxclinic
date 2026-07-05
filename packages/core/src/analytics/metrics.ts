// SPDX-License-Identifier: Apache-2.0
/**
 * Analytics metrics — pure, deterministic functions over store data (no I/O).
 *
 * See docs/design-analytics.md for the v1 formulas and constants chosen here. These
 * are the coverage-gated logic the Analytics view renders; the UI re-derives nothing.
 */

import type { Domain, Sender, SenderCategory, TrustStatus } from "../store/types";

// --- Inbox health score (0–100) ------------------------------------------------

/**
 * Weights for the three health components (sum to 1). Documented in
 * docs/design-analytics.md (Decision: inbox health score).
 */
export const HEALTH_COVERAGE_WEIGHT = 0.5;
export const HEALTH_READ_WEIGHT = 0.3;
export const HEALTH_HYGIENE_WEIGHT = 0.2;

/** Score returned when there is nothing to assess (no senders). */
export const HEALTH_NEUTRAL = 50;

/** Read rate assumed for the read component when no sender has a measured rate. */
const HEALTH_READ_FALLBACK = 0.5;

export interface InboxHealthInput {
  /** Senders the user has trusted. */
  trusted: number;
  /** Senders the user has blocked. */
  blocked: number;
  /** Senders still awaiting a decision. */
  pending: number;
  /** Mean read rate (0–1) across senders that have one, or `null` if none do. */
  avgReadRate: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Inbox health on a 0–100 scale, blending three normalised components:
 *
 *   coverage = decided / total          (you have triaged your senders)
 *   hygiene  = blocked / decided        (you have removed noise)
 *   read     = mean read rate           (what reaches you is relevant)
 *
 * health = round(100 × (0.5·coverage + 0.3·read + 0.2·hygiene)), clamped to 0–100.
 * With no senders the score is neutral (50). See docs/design-analytics.md.
 */
export function inboxHealthScore(input: InboxHealthInput): number {
  const total = input.trusted + input.blocked + input.pending;
  if (total <= 0) return HEALTH_NEUTRAL;

  const decided = input.trusted + input.blocked;
  const coverage = decided / total;
  const hygiene = decided > 0 ? input.blocked / decided : 0;
  const read = input.avgReadRate ?? HEALTH_READ_FALLBACK;

  const raw =
    HEALTH_COVERAGE_WEIGHT * coverage + HEALTH_READ_WEIGHT * read + HEALTH_HYGIENE_WEIGHT * hygiene;
  return Math.round(clamp(raw, 0, 1) * 100);
}

/** Build the health input from a sender set (mean read rate over those that have one). */
export function healthInputFromSenders(senders: Sender[]): InboxHealthInput {
  let trusted = 0;
  let blocked = 0;
  let pending = 0;
  let readSum = 0;
  let readCount = 0;
  for (const sender of senders) {
    if (sender.trustStatus === "trusted") trusted += 1;
    else if (sender.trustStatus === "blocked") blocked += 1;
    else pending += 1;
    if (sender.readRate !== null) {
      readSum += sender.readRate;
      readCount += 1;
    }
  }
  return {
    trusted,
    blocked,
    pending,
    avgReadRate: readCount > 0 ? readSum / readCount : null,
  };
}

// --- Estimated time saved ------------------------------------------------------

/**
 * Seconds of inbox-handling time assumed saved per email that no longer reaches the
 * inbox (skim + delete/file). A deliberately conservative v1 constant; see
 * docs/design-analytics.md.
 */
export const SECONDS_PER_BLOCKED_EMAIL = 5;

/** Estimated time saved (seconds) from the count of blocked emails. */
export function estimatedTimeSaved(emailsBlocked: number): number {
  if (!Number.isFinite(emailsBlocked) || emailsBlocked <= 0) return 0;
  return Math.round(emailsBlocked) * SECONDS_PER_BLOCKED_EMAIL;
}

// --- Category breakdown --------------------------------------------------------

export interface CategoryStat {
  category: SenderCategory;
  senders: number;
  emails: number;
}

/**
 * Sender/email counts grouped by category, highest email volume first (ties broken by
 * category name). Categories with no senders are omitted.
 */
export function categoryBreakdown(senders: Sender[]): CategoryStat[] {
  const byCategory = new Map<SenderCategory, CategoryStat>();
  for (const sender of senders) {
    const stat = byCategory.get(sender.category) ?? {
      category: sender.category,
      senders: 0,
      emails: 0,
    };
    stat.senders += 1;
    stat.emails += sender.totalEmails;
    byCategory.set(sender.category, stat);
  }
  return [...byCategory.values()].sort(
    (a, b) => b.emails - a.emails || a.category.localeCompare(b.category),
  );
}

// --- Top domains by volume -----------------------------------------------------

export interface DomainVolume {
  domain: string;
  totalEmails: number;
  senderCount: number;
  trustStatus: TrustStatus;
}

export interface TopDomainsOptions {
  /** Restrict to domains in this trust status (e.g. `'blocked'`). */
  status?: TrustStatus;
}

/** The `limit` highest-volume domains, optionally filtered by trust status. */
export function topDomainsByVolume(
  domains: Domain[],
  limit: number,
  options: TopDomainsOptions = {},
): DomainVolume[] {
  const filtered =
    options.status === undefined
      ? domains
      : domains.filter((d) => d.trustStatus === options.status);
  return filtered
    .map((d) => ({
      domain: d.domain,
      totalEmails: d.totalEmails,
      senderCount: d.senderCount,
      trustStatus: d.trustStatus,
    }))
    .sort((a, b) => b.totalEmails - a.totalEmails || a.domain.localeCompare(b.domain))
    .slice(0, Math.max(0, limit));
}

// --- Achievements --------------------------------------------------------------

export interface AchievementInput {
  decisionsMade: number;
  sendersBlocked: number;
  sendersTrusted: number;
  emailsBlocked: number;
  estimatedTimeSavedSeconds: number;
  inboxHealthScore: number;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  earned: boolean;
}

/** Seconds in an hour — the Time Saver threshold. */
const ONE_HOUR_SECONDS = 3600;

interface AchievementRule {
  id: string;
  name: string;
  description: string;
  met: (s: AchievementInput) => boolean;
}

/**
 * Rule-based badges with documented thresholds (docs/design-analytics.md). Each is a
 * pure predicate over cumulative stats; order is the display order.
 */
const ACHIEVEMENT_RULES: AchievementRule[] = [
  {
    id: "first-block",
    name: "First Block",
    description: "Block your first sender.",
    met: (s) => s.sendersBlocked >= 1,
  },
  {
    id: "trust-builder",
    name: "Trust Builder",
    description: "Trust 10 senders.",
    met: (s) => s.sendersTrusted >= 10,
  },
  {
    id: "clean-sweep",
    name: "Clean Sweep",
    description: "Block 10 senders.",
    met: (s) => s.sendersBlocked >= 10,
  },
  {
    id: "triage-master",
    name: "Triage Master",
    description: "Make 50 trust decisions.",
    met: (s) => s.decisionsMade >= 50,
  },
  {
    id: "time-saver",
    name: "Time Saver",
    description: "Save an hour of inbox time.",
    met: (s) => s.estimatedTimeSavedSeconds >= ONE_HOUR_SECONDS,
  },
  {
    id: "inbox-hero",
    name: "Inbox Hero",
    description: "Reach an inbox health score of 80.",
    met: (s) => s.inboxHealthScore >= 80,
  },
];

/** Evaluate every achievement rule against the supplied stats. */
export function achievements(input: AchievementInput): Achievement[] {
  return ACHIEVEMENT_RULES.map((rule) => ({
    id: rule.id,
    name: rule.name,
    description: rule.description,
    earned: rule.met(input),
  }));
}
