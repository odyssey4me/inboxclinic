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
 * The broader port (incremental sync, actions, native-filter reconcile) arrives in
 * later milestones.
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
}
