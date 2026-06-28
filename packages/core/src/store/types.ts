/**
 * On-device entity types.
 *
 * See docs/design-local-store-schema.md ("Object stores") and architecture.md §5.
 * Records are keyed by `keyFor(...)` (URL-safe Base64 of the lowercased value). The
 * sender's `domain` is denormalised so per-domain queries need no join (§6).
 *
 * M1 fully populates `profile`, `senders`, and `domains`. The remaining entities
 * (`prompts`, analytics, `filterSyncState`, `settings`) are typed minimally here so
 * the `Store` port (store/Store.ts) is complete; later milestones flesh them out.
 */

/** A trust decision state for a sender or domain. */
export type TrustStatus = "trusted" | "blocked" | "pending";

/** Email cadence band for a sender (design-trust-decisions.md, frequency signal). */
export type Frequency = "daily" | "weekly" | "monthly" | "rare";

/**
 * Non-overlapping recency buckets (counts of emails by age at scan time). The
 * boundaries match the recency weights in design-trust-decisions.md: ≤30d, 30–90d,
 * 90–180d, >180d.
 */
export interface RecencyBuckets {
  d30: number;
  d90: number;
  d180: number;
  older: number;
}

/** Delivery-authentication signals parsed from `Authentication-Results`. */
export interface AuthSignals {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  spoofed: boolean;
}

/**
 * M1 sender category. A deterministic bucket derived from Gmail category labels,
 * list headers, and frequency — see senders/extract.ts. (The richer trust-decisions
 * taxonomy lands with scoring in M2.)
 */
export type SenderCategory = "promotional" | "transactional" | "personal" | "other";

/** Per-account profile. Single record keyed by `googleEmail`. */
export interface Profile {
  googleEmail: string;
  onboardingComplete: boolean;
  /** History-API marker; a placeholder (`null`) until incremental sync (M5). */
  lastHistoryId: string | null;
  senderCount: number;
  domainCount: number;
  messageCount: number;
  /** Epoch ms of the most recent scan, or `null` before the first scan. */
  lastScanAt: number | null;
  privacy: ProfilePrivacy;
}

export interface ProfilePrivacy {
  /** Aggregate-contribution opt-in seam (architecture.md §9); default `true`. */
  contributeToAggregate: boolean;
}

/** Per-sender record. Primary key `id = keyFor(email)`. */
export interface Sender {
  id: string;
  email: string;
  /** Denormalised domain (design-local-store-schema.md indexes `domain`). */
  domain: string;
  displayName: string | null;
  category: SenderCategory;
  trustStatus: TrustStatus;
  totalEmails: number;
  hasListUnsubscribe: boolean;
  hasListId: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  updatedAt: number;

  // --- Trust signals (metadata-derived; M2) --------------------------------
  /** Fraction of messages read: `1 − UNREAD/total`. `null` only if `total` is 0. */
  readRate: number | null;
  /** Messages carrying the Gmail `STARRED` label. */
  starredCount: number;
  /** Messages carrying the Gmail `SPAM` label. */
  spamMarkedCount: number;
  /** Replies the user sent to this sender. Deferred (SENT scan) — `0` for now. */
  replyCount: number;
  /** Whether the sender is in the user's contacts. Deferred (People API) — `false`. */
  inContacts: boolean;
  /** Email cadence band derived from the 30-day count. */
  frequency: Frequency;
  /** Email counts bucketed by recency at scan time. */
  recencyBuckets: RecencyBuckets;
  /** Delivery-authentication posture from the most recent authenticated message. */
  auth: AuthSignals;
}

/** Per-domain aggregate. Primary key `id = keyFor(domain)`. */
export interface Domain {
  id: string;
  domain: string;
  trustStatus: TrustStatus;
  senderCount: number;
  totalEmails: number;
  /** Address-level exceptions to a domain decision (design-trust-decisions.md). */
  exceptionAddresses: string[];
  updatedAt: number;
}

/** The four weighted components behind a prompt's priority (design-trust-decisions.md). */
export interface PriorityComponents {
  impact: number;
  confidence: number;
  batch: number;
  alignment: number;
}

/**
 * A pending trust prompt for an undecided sender. Primary key `id`. 30-day TTL.
 * See design-trust-decisions.md (prompt priority) and design-local-store-schema.md.
 */
export interface Prompt {
  id: string;
  senderId: string;
  priorityScore: number;
  components: PriorityComponents;
  /** e.g. `"domain:company.com"`, or `null` when not batchable. */
  batchGroupId: string | null;
  /** Number of same-batch candidates (≥1). */
  batchSize: number;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

// --- Deferred entities (typed minimally so the Store port is complete) ---------

export interface DailyAnalytics {
  date: string; // YYYY-MM-DD
}

export interface MonthlyAnalytics {
  month: string; // YYYY-MM
}

export interface FilterSyncState {
  key: string; // singleton key
  lastSyncAt: number | null;
  totalFilters: number;
}

export interface Setting {
  key: string;
  value: unknown;
}
