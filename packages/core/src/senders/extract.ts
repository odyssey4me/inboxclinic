// SPDX-License-Identifier: Apache-2.0
/**
 * Sender / domain extraction and categorisation — pure, no I/O.
 *
 * See docs/design-gmail-integration.md ("Example 1: Bounded scan, then sender
 * extraction") and docs/design-trust-decisions.md (sender categorisation signals).
 *
 * Given metadata-only `MessageMeta[]`, group messages by sender address, denormalise
 * the domain onto each sender, aggregate per-domain counts, and assign an M1
 * `SenderCategory` from a deterministic decision tree over Gmail category labels,
 * `List-Unsubscribe` / `List-Id` presence, and frequency.
 */

import { keyFor } from "../keys";
import type { MessageMeta } from "../ports/GmailClient";
import type {
  AuthSignals,
  Domain,
  Frequency,
  RecencyBuckets,
  Sender,
  SenderCategory,
} from "../store/types";
import { ageInDays, bucketForAgeDays, emptyBuckets } from "./recency";

/** 30-day counts at/above these treat a sender as the given cadence band. */
const FREQUENCY_DAILY = 20;
const FREQUENCY_WEEKLY = 4;
const FREQUENCY_MONTHLY = 1;

/** Derive a cadence band from the 30-day message count. */
export function frequencyFor(emails30d: number): Frequency {
  if (emails30d >= FREQUENCY_DAILY) return "daily";
  if (emails30d >= FREQUENCY_WEEKLY) return "weekly";
  if (emails30d >= FREQUENCY_MONTHLY) return "monthly";
  return "rare";
}

/**
 * Parse an `Authentication-Results` header into pass/fail booleans and a spoofing
 * verdict. `spoofed` when DMARC fails, or when both SPF and DKIM fail.
 */
export function parseAuthResults(header: string | undefined): AuthSignals {
  if (header === undefined) return { spf: false, dkim: false, dmarc: false, spoofed: false };
  const spf = /spf=pass/i.test(header);
  const dkim = /dkim=pass/i.test(header);
  const dmarc = /dmarc=pass/i.test(header);
  const dmarcFail = /dmarc=fail/i.test(header);
  const spfFail = /spf=fail/i.test(header);
  const dkimFail = /dkim=fail/i.test(header);
  return { spf, dkim, dmarc, spoofed: dmarcFail || (spfFail && dkimFail) };
}

/** A parsed `From` header. */
export interface ParsedAddress {
  email: string; // lowercased, normalised
  domain: string; // lowercased
  displayName: string | null;
}

/**
 * Senders with this many or more messages in the scan window are treated as bulk
 * automated senders when no label or list-header signal is present.
 */
export const HIGH_VOLUME_THRESHOLD = 10;

/**
 * Parse a `From` header into a normalised address.
 *
 * Accepts `"Display Name" <user@host>`, `Display Name <user@host>`, and bare
 * `user@host`. Returns `null` when no plausible `local@domain` address is present.
 */
export function parseFromHeader(raw: string | undefined): ParsedAddress | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let displayName: string | null = null;
  let address = trimmed;

  // Extract a `<address>` with linear string ops. The From header is untrusted, so a
  // greedy unanchored regex like /<([^>]+)>/ is a polynomial-ReDoS risk (js/polynomial
  // -redos); indexOf is O(n) and matches the same first-`<address>` semantics.
  const open = trimmed.indexOf("<");
  const close = open === -1 ? -1 : trimmed.indexOf(">", open + 1);
  if (close > open + 1) {
    address = trimmed.slice(open + 1, close).trim();
    const name = trimmed.slice(0, open).trim().replace(/^"|"$/g, "").trim();
    displayName = name === "" ? null : name;
  }

  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;

  const email = address.toLowerCase();
  const domain = email.slice(at + 1);
  if (!domain.includes(".")) return null;

  return { email, domain, displayName };
}

/** Aggregated signals for one sender, fed to {@link categorise}. */
export interface CategorySignals {
  labelIds: Set<string>;
  hasListUnsubscribe: boolean;
  hasListId: boolean;
  totalEmails: number;
}

/**
 * Assign an M1 category from a deterministic precedence over the available signals.
 *
 * 1. Gmail category labels are the strongest signal:
 *    - `CATEGORY_PROMOTIONS`            → promotional
 *    - `CATEGORY_UPDATES`               → transactional
 *    - `CATEGORY_PERSONAL`              → personal
 *    - `CATEGORY_SOCIAL` / `_FORUMS`    → other
 * 2. Otherwise list headers indicate bulk mail:
 *    - `List-Unsubscribe` present       → promotional (marketing/newsletter convention)
 *    - `List-Id` present (no unsubscribe) → transactional (mailing list / automated)
 * 3. Otherwise fall back to frequency:
 *    - ≥ {@link HIGH_VOLUME_THRESHOLD}  → other (frequent, unlabelled, non-list)
 *    - fewer                            → personal (reads as one-to-one mail)
 */
export function categorise(signals: CategorySignals): SenderCategory {
  const { labelIds, hasListUnsubscribe, hasListId, totalEmails } = signals;

  if (labelIds.has("CATEGORY_PROMOTIONS")) return "promotional";
  if (labelIds.has("CATEGORY_UPDATES")) return "transactional";
  if (labelIds.has("CATEGORY_PERSONAL")) return "personal";
  if (labelIds.has("CATEGORY_SOCIAL") || labelIds.has("CATEGORY_FORUMS")) return "other";

  if (hasListUnsubscribe) return "promotional";
  if (hasListId) return "transactional";

  return totalEmails >= HIGH_VOLUME_THRESHOLD ? "other" : "personal";
}

interface SenderAccumulator {
  email: string;
  domain: string;
  displayName: string | null;
  labelIds: Set<string>;
  hasListUnsubscribe: boolean;
  hasListId: boolean;
  totalEmails: number;
  firstSeenAt: number;
  lastSeenAt: number;
  unreadCount: number;
  starredCount: number;
  spamMarkedCount: number;
  buckets: RecencyBuckets;
  /** Auth posture of the most recent message that carried the header. */
  auth: AuthSignals;
  latestAuthDate: number;
}

/** Apply one message's metadata signals to a sender accumulator. */
function applyMessageSignals(acc: SenderAccumulator, meta: MessageMeta, now: number): void {
  if (meta.labelIds.includes("UNREAD")) acc.unreadCount += 1;
  if (meta.labelIds.includes("STARRED")) acc.starredCount += 1;
  if (meta.labelIds.includes("SPAM")) acc.spamMarkedCount += 1;

  acc.buckets[bucketForAgeDays(ageInDays(now, meta.internalDate))] += 1;

  const authHeader = meta.headers.authenticationResults;
  if (authHeader !== undefined && meta.internalDate >= acc.latestAuthDate) {
    acc.auth = parseAuthResults(authHeader);
    acc.latestAuthDate = meta.internalDate;
  }
}

export interface ExtractResult {
  senders: Sender[];
  domains: Domain[];
}

/**
 * Extract per-sender and per-domain records from a batch of message metadata.
 *
 * Messages whose `From` cannot be parsed are skipped. `now` (default `Date.now()`)
 * stamps `updatedAt`, keeping the function deterministic in tests.
 */
export function extractSenders(metas: MessageMeta[], now: number = Date.now()): ExtractResult {
  const accumulators = new Map<string, SenderAccumulator>();

  for (const meta of metas) {
    const parsed = parseFromHeader(meta.headers.from);
    if (parsed === null) continue;

    let acc = accumulators.get(parsed.email);
    const hasUnsub = meta.headers.listUnsubscribe !== undefined;
    const hasListId = meta.headers.listId !== undefined;

    if (acc === undefined) {
      acc = {
        email: parsed.email,
        domain: parsed.domain,
        displayName: parsed.displayName,
        labelIds: new Set(meta.labelIds),
        hasListUnsubscribe: hasUnsub,
        hasListId,
        totalEmails: 1,
        firstSeenAt: meta.internalDate,
        lastSeenAt: meta.internalDate,
        unreadCount: 0,
        starredCount: 0,
        spamMarkedCount: 0,
        buckets: emptyBuckets(),
        auth: { spf: false, dkim: false, dmarc: false, spoofed: false },
        latestAuthDate: -1,
      };
      accumulators.set(parsed.email, acc);
      applyMessageSignals(acc, meta, now);
      continue;
    }

    acc.totalEmails += 1;
    acc.hasListUnsubscribe ||= hasUnsub;
    acc.hasListId ||= hasListId;
    for (const label of meta.labelIds) acc.labelIds.add(label);
    if (acc.displayName === null && parsed.displayName !== null)
      acc.displayName = parsed.displayName;
    if (meta.internalDate < acc.firstSeenAt) acc.firstSeenAt = meta.internalDate;
    if (meta.internalDate > acc.lastSeenAt) acc.lastSeenAt = meta.internalDate;
    applyMessageSignals(acc, meta, now);
  }

  const senders: Sender[] = [];
  const domainAcc = new Map<string, { totalEmails: number; senderCount: number }>();

  for (const acc of accumulators.values()) {
    const emails30d = acc.buckets.d30;
    senders.push({
      id: keyFor(acc.email),
      email: acc.email,
      domain: acc.domain,
      displayName: acc.displayName,
      category: categorise({
        labelIds: acc.labelIds,
        hasListUnsubscribe: acc.hasListUnsubscribe,
        hasListId: acc.hasListId,
        totalEmails: acc.totalEmails,
      }),
      trustStatus: "pending",
      totalEmails: acc.totalEmails,
      hasListUnsubscribe: acc.hasListUnsubscribe,
      hasListId: acc.hasListId,
      firstSeenAt: acc.firstSeenAt,
      lastSeenAt: acc.lastSeenAt,
      updatedAt: now,
      readRate: acc.totalEmails > 0 ? 1 - acc.unreadCount / acc.totalEmails : null,
      starredCount: acc.starredCount,
      spamMarkedCount: acc.spamMarkedCount,
      // Populated from the prior-decisions learn pass (Trash / filters), not the inbox scan.
      deletedUnreadCount: 0,
      coveredByBlockFilter: false,
      replyCount: 0,
      inContacts: false,
      frequency: frequencyFor(emails30d),
      recencyBuckets: acc.buckets,
      auth: acc.auth,
      trustDecidedAt: null,
      decisionScope: null,
      decisionContext: null,
      pendingActions: [],
    });

    const d = domainAcc.get(acc.domain) ?? { totalEmails: 0, senderCount: 0 };
    d.totalEmails += acc.totalEmails;
    d.senderCount += 1;
    domainAcc.set(acc.domain, d);
  }

  const domains: Domain[] = [...domainAcc.entries()].map(([domain, d]) => ({
    id: keyFor(domain),
    domain,
    trustStatus: "pending",
    senderCount: d.senderCount,
    totalEmails: d.totalEmails,
    exceptionAddresses: [],
    updatedAt: now,
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
  }));

  return { senders, domains };
}
