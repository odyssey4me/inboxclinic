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

// --- Deferred entities (typed minimally so the Store port is complete) ---------

export interface Prompt {
  id: string;
  senderId: string;
  priorityScore: number;
  batchGroupId: string | null;
  expiresAt: number;
  resolvedAt: number | null;
}

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
