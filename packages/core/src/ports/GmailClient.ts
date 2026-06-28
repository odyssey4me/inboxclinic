/**
 * `GmailClient` port — the provider-client interface for Inbox Clinic.
 *
 * See docs/design-gmail-integration.md ("`GmailClient` port") and architecture.md
 * §6 (Core Interfaces). The port is framework-agnostic: product logic and the scan
 * orchestration depend on this interface, not on any transport. A browser PKCE/GIS
 * adapter lives in `apps/web`; a `MockGmailClient` (in `../testing`) backs the tests.
 *
 * M1 surface (read-only): authenticate, read the signed-in account identity, list
 * message ids for a bounded query, and fetch per-message **metadata only** (headers
 * and labels — never bodies or snippets; design-gmail-integration.md Decision 3).
 *
 * M4 surface (enforcement, Tier 2): native-filter list/create/delete and bounded
 * message label edits (archive / trash / Trust rescue), plus a `from:`-scoped id
 * lookup. Reads stay metadata-only; writes are best-effort and idempotent (the local
 * decision is the source of truth — design-gmail-integration.md Decision 5).
 */

/** Short-lived bearer token + the scopes Google actually granted. In-memory only. */
export interface AccessToken {
  /** The opaque OAuth bearer token. Never persisted (design Decision 1). */
  value: string;
  /** Epoch ms at which the token expires; held in memory only. */
  expiresAt: number;
  /** The scopes Google actually granted for this token. */
  grantedScopes: string[];
}

/** Tiered scopes; least-permission per architecture.md §6. M1 only needs Tier 1. */
export type ScopeTier = 1 | 2 | 3;

/** The Tier-1 read-only Gmail scope used by the M1 inbox scan. */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Tier-2 scope: archive / trash / relabel existing mail (`users.messages.modify`). */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** Tier-2 scope: read/write native filters (`users.settings.filters`). */
export const GMAIL_SETTINGS_BASIC_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";

/**
 * Least-permission scopes requested per tier (design-gmail-integration.md Decision 2).
 * Tier 1 is read-only; Tier 2 adds enforcement; Tier 3 (contacts) is deferred.
 */
export const SCOPES_BY_TIER: Record<ScopeTier, string[]> = {
  1: [GMAIL_READONLY_SCOPE],
  2: [GMAIL_MODIFY_SCOPE, GMAIL_SETTINGS_BASIC_SCOPE],
  3: [],
};

/**
 * Parsed, typed projection of the metadata headers the scan reads.
 *
 * Every field is optional because senders do not always supply every header. Only
 * the headers listed in design-gmail-integration.md Decision 3 are ever requested.
 */
export interface MessageHeaders {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  messageId?: string;
  replyTo?: string;
  listUnsubscribe?: string;
  listId?: string;
  authenticationResults?: string;
}

/** Metadata-only message projection — no body, no snippet (design Decision 3). */
export interface MessageMeta {
  id: string;
  threadId: string;
  /** Gmail system + category labels, e.g. `INBOX`, `CATEGORY_PROMOTIONS`. */
  labelIds: string[];
  /** Epoch ms the message was received (Gmail `internalDate`). */
  internalDate: number;
  headers: MessageHeaders;
}

/**
 * A compiled native-filter spec (design-gmail-integration.md Decision 5). `from` is
 * the Gmail filter `criteria.from` value — a single address (`a@x.com`), a domain
 * wildcard (`*@x.com`), or an OR-combination (`*@a.com OR *@b.com`). The label edit is
 * the filter `action` (e.g. add `TRASH`, remove `INBOX`).
 */
export interface FilterSpec {
  from: string;
  addLabelIds: string[];
  removeLabelIds: string[];
}

/** An existing native filter as returned by Gmail — a `FilterSpec` plus its id. */
export interface NativeFilter extends FilterSpec {
  id: string;
}

/** A bounded label edit applied to existing messages (`users.messages.batchModify`). */
export interface MessageLabelEdit {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

/**
 * The provider-client port. Implementations are adapters (browser fetch + GIS in
 * `apps/web`; an in-memory fixture mock in `../testing`).
 */
export interface GmailClient {
  /** Acquire (or refresh) an access token for the requested scope tiers (default Tier 1). */
  authenticate(tiers?: ScopeTier[]): Promise<AccessToken>;
  /** Return a valid in-memory token, authenticating transparently if needed/expired. */
  getAccessToken(): Promise<AccessToken>;
  /** The signed-in Google account address — used as the `profile` primary key. */
  getAccountEmail(): Promise<string>;
  /** List message ids matching a Gmail search query, bounded by `max`. */
  listMessageIds(query: string, max: number): Promise<string[]>;
  /** Fetch a single message's metadata (headers + labels only). */
  getMessageMeta(id: string): Promise<MessageMeta>;

  // --- Enforcement (Tier 2; M4) -------------------------------------------
  /** List the account's native Gmail filters (`users.settings.filters.list`). */
  listFilters(): Promise<NativeFilter[]>;
  /** Create one native filter; resolves to the created filter (with its id). */
  createFilter(spec: FilterSpec): Promise<NativeFilter>;
  /** Delete a native filter by id (`users.settings.filters.delete`). */
  deleteFilter(id: string): Promise<void>;
  /** Apply a label edit to a batch of message ids (`users.messages.batchModify`). */
  batchModifyMessages(ids: string[], edit: MessageLabelEdit): Promise<void>;
  /** List message ids whose `From` matches the given address or `*@domain` clause. */
  listMessageIdsForSender(from: string, max?: number): Promise<string[]>;
}
