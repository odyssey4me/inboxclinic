// SPDX-License-Identifier: Apache-2.0
/**
 * The Google OAuth scopes Inbox Clinic requests.
 *
 * See docs/design-gmail-integration.md Decision 2 and architecture.md §6. Every scope
 * the app can ever use is requested **once, at sign-in**, as a single grant — there is
 * no mid-session escalation. {@link GOOGLE_SCOPES} is that grant, and it is the only
 * place a scope set is assembled: adding a capability that needs a new permission
 * widens this constant (and therefore the sign-in prompt), never introduces a second
 * prompt somewhere else.
 *
 * Minimality still applies, but to *what* is requested rather than *when*: each scope
 * below is the narrowest one that supports its capability.
 */

/**
 * Read message metadata *and* archive / trash / relabel existing mail. This one scope
 * covers both the scan (`users.getProfile`, `messages.list`,
 * `messages.get?format=metadata`, `history.list`) and enforcement
 * (`users.messages.modify`), so `gmail.readonly` is **deliberately absent** from the
 * grant below: under the old tiered design it meant something because it could be
 * granted alone, but in a single prompt alongside `gmail.modify` it is a strict subset
 * — one more restricted scope on the consent screen buying no capability.
 */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** Read/write native filters (`users.settings.filters`) — the enforcement layer. */
export const GMAIL_SETTINGS_BASIC_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";

/**
 * Read/write **only** files the app itself creates or opens — it cannot enumerate or
 * read the rest of the user's Drive (docs/design-backup-restore.md Decision 2).
 */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * The complete sign-in grant. `contacts.readonly` is deliberately absent: the People
 * API lookup is deferred, and an unused scope has no business on the consent screen.
 * When that lookup ships it joins this array rather than prompting separately.
 */
export const GOOGLE_SCOPES: readonly string[] = [
  GMAIL_MODIFY_SCOPE,
  GMAIL_SETTINGS_BASIC_SCOPE,
  DRIVE_FILE_SCOPE,
];
