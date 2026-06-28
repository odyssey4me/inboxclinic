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

/** Whether a decision applies to an address or a whole domain (domain overrides). */
export type DecisionScope = "address" | "domain";

/** Where in the UI a decision was made (design-trust-decisions.md). */
export type DecidedVia = "workflow" | "dashboard" | "settings";

/** A user trust decision. */
export type Decision = "trust" | "block" | "defer";

/** An enforcement action a Block can compile into (executed in M4, not here). */
export type BlockAction = "unsubscribe" | "create_filter" | "archive" | "delete";

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
 * What was true about a subject at decision time (design-trust-decisions.md,
 * Decision 5). Captured on each decision for audit / undo and future alignment.
 */
export interface DecisionContext {
  readRate: number | null;
  totalEmails: number;
  frequency: Frequency;
  trustScore: number;
  category: SenderCategory;
  decidedVia: DecidedVia;
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
  /** History-API marker for incremental sync; `null` until the first scan seeds it. */
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

  // --- Decision record (M3) ------------------------------------------------
  /** Epoch ms the current decision was made, or `null` while undecided. */
  trustDecidedAt: number | null;
  /** Scope of the recorded decision, or `null` while undecided. */
  decisionScope: DecisionScope | null;
  /** Snapshot of evidence at decision time, or `null` while undecided. */
  decisionContext: DecisionContext | null;
  /** Block actions awaiting Gmail enforcement (applied in M4). */
  pendingActions: BlockAction[];
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

  // --- Decision record (M3) ------------------------------------------------
  trustDecidedAt: number | null;
  decisionScope: DecisionScope | null;
  decisionContext: DecisionContext | null;
  pendingActions: BlockAction[];
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
  /** Epoch ms when a Trust/Block resolved this prompt, or `null` while open. */
  resolvedAt: number | null;
  /** Epoch ms of the most recent Defer (priority decayed), or `null`. */
  deferredAt: number | null;
}

// --- Analytics entities (M6) ----------------------------------------------------

/**
 * Reconstruction-proof daily counters accumulated at scan/sync/decision/enforce
 * events. These record *what happened on a given day* — they cannot be recomputed
 * from current state (a re-decided sender or a changed count erases the history), so
 * they are the only analytics data that must be persisted incrementally. Derived
 * metrics (health, time-saved, breakdowns) are computed on demand from current state.
 * See docs/design-analytics.md.
 */
export interface DailyAnalytics {
  date: string; // YYYY-MM-DD (UTC)
  /** Senders newly discovered this day (scan / incremental sync). */
  newSenders: number;
  /** Trust/block/defer decisions recorded this day. */
  decisionsMade: number;
  /** Subjects blocked this day (a sender, or each covered domain member). */
  sendersBlocked: number;
  /** Subjects trusted this day. */
  sendersTrusted: number;
  /** Existing messages removed from the inbox this day (archive + trash, enforce). */
  emailsBlocked: number;
  /** Messages pulled back out of Spam/Trash this day (Trust rescue, enforce). */
  emailsRescued: number;
}

/**
 * Monthly rollup of the daily counters plus the on-demand derived metrics. Persisted
 * by the analytics summary so the schema's `analyticsMonthly` store stays meaningful;
 * the values are always recomputable from `analyticsDaily` + current state.
 */
export interface MonthlyAnalytics {
  month: string; // YYYY-MM (UTC)
  newSenders: number;
  decisionsMade: number;
  sendersBlocked: number;
  sendersTrusted: number;
  emailsBlocked: number;
  emailsRescued: number;
  /** Inbox health score (0–100) at rollup time. */
  inboxHealthScore: number;
  /** Estimated time saved, in seconds. */
  estimatedTimeSaved: number;
  /** Ids of the achievements earned (see docs/design-analytics.md). */
  achievements: string[];
}

// --- Deferred entities (typed minimally so the Store port is complete) ---------

export interface FilterSyncState {
  key: string; // singleton key
  lastSyncAt: number | null;
  totalFilters: number;
}

export interface Setting {
  key: string;
  value: unknown;
}
