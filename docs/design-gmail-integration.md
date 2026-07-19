# Design: Gmail Integration (Client-Only)

> **Status:** Draft (Alpha)
>
> **Last Updated:** 2026-07-12

## Overview

Inbox Clinic is a **client-only, local-first, all-TypeScript browser PWA with no
backend**. Every Gmail interaction happens **directly from the browser** against
Google's APIs using a short-lived OAuth access token. This document owns the
**client-side Gmail integration interfaces and conventions**: browser OAuth, the
metadata-only scan, sender/domain extraction, native-filter compilation for
enforcement, and the `GmailClient` port that lives in `packages/core`.

It establishes consistent patterns for:

- Browser **PKCE public-client** OAuth via Google Identity Services (no secret, no
  stored refresh token).
- A **metadata-only** bounded scan and **History-API** incremental sync.
- Sender/domain extraction, categorisation, and optional contacts lookup.
- Compiling user decisions into **native Gmail filters** as the durable enforcement
  layer.
- Replacing the old server push pipeline with **polling + client-side periodic sync**.

> This is a ground-up redesign. The previous server-based design (Watch API →
> Pub/Sub push, server workers, KMS-encrypted refresh tokens) is **superseded** —
> see [Migration Notes](#migration-notes). architecture.md is the source of truth.

## Architecture Reference

This design implements the following sections of
[architecture.md](architecture.md):

> **Keep It DRY:** link to architecture.md rather than copying. This doc defines the
> *client interfaces*; architecture.md defines *what to build*.

| Section | Title | Relevance |
|---------|-------|-----------|
| 2 | Constraints | Gmail-only provider; client-only with no backend; no credential custody |
| 3 | System Model | Browser talks directly to the provider and stores all user data on-device |
| 6 | Core Interfaces | Provider-client port (auth, metadata scan, actions, native-filter reconcile); least-permission scopes |

## Design Decisions

### Decision 1: PKCE public client, tokens in memory

**Context:** A static PWA cannot keep a client secret, and storing a refresh token in
the browser is an exfiltration risk with no server to protect it.

**Decision:** Use the **OAuth 2.0 Authorization Code + PKCE** flow via Google Identity
Services as a **public client**. Ship **no client secret**. Hold the **access token in
memory only** (never IndexedDB, never `localStorage`). When the token expires, prompt
the user to re-consent.

**Rationale:** Eliminates credential custody (architecture.md §2). PKCE is the
Google-recommended flow for browser apps.

**Alternatives considered:**
- Implicit flow — rejected; deprecated and leaks tokens in URLs.
- Stored refresh token — rejected on web; reserved for a future native build where a
  platform keychain exists (architecture.md §9).

### Decision 2: Incremental scope tiers

**Context:** Users hesitate to grant broad access before trusting the app, and Tiers
2–3 are Google **restricted scopes**.

**Decision:** Request the minimum and escalate on demand using **incremental
authorisation** (least-permission; architecture.md §6):

| Tier | Scope(s) | Enables |
|------|----------|---------|
| 1 (required) | `gmail.readonly` | Inbox scan, sender extraction, trust scoring |
| 2 (enforcement) | `gmail.modify`, `gmail.settings.basic` | Archive/delete/relabel, native filter sync |
| 3 (optional) | `contacts.readonly` (People API) | "In contacts" trust signal — **deferred, not requested in v1** (see [ROADMAP.md](ROADMAP.md#deferred-post-v1)) |

**Rationale:** Read-only first builds trust; enforcement scopes are only requested
when the user acts. The hosted instance runs in **testing mode with a ≤100-email
allowlist**, so restricted scopes need **no verification or CASA assessment**
(architecture.md §7).

### Decision 3: Metadata-only access

**Decision:** Read only headers and labels via `messages.get?format=metadata`. Request
headers `From`, `To`, `Subject`, `Date`, `Message-ID`, `Reply-To`, `List-Unsubscribe`,
`List-Id`, `Authentication-Results`, plus `labelIds`. **Never** fetch bodies or
snippets.

**Rationale:** Metadata is sufficient for sender trust analysis and honours data
minimisation (architecture.md §5). Initial scan is bounded (default 30 days, `INBOX`).

### Decision 4: Polling + client-side periodic sync (no push)

**Context:** The old design used Gmail **Watch → Pub/Sub push** with server workers.
A client-only app has no server to receive webhooks.

**Decision:** Replace the entire push pipeline with **polling**. On app open and via a
**service-worker periodic sync** (where the platform permits), call the **History API**
from `profile.lastHistoryId`. On a `404` (stale `historyId`), transparently run a
**bounded rescan** and reset the marker. There is **no Pub/Sub, no Watch, no webhooks,
and no server token refresh**.

**Rationale:** Native Gmail filters (Decision 5) enforce continuously server-side even
while the app is closed, so the app only needs to *observe* changes, not react in real
time. Polling is sufficient and removes all server infrastructure.

### Decision 5: Native filter compilation as the enforcement layer

**Context:** A client-only app cannot act on mail when closed; Gmail has a **~500
filter per account** limit.

**Decision:** Compile block decisions into **native Gmail filters** so Google enforces
them continuously (architecture.md §6):

1. **Sender block →** `from:<address>` → Trash / skip-inbox.
2. When **3+ senders from one domain** are blocked, prefer a **domain-level** filter
   `from:*@domain.com`.
3. **OR-combine ≤10 domains** per filter: `from:(*@a.com OR *@b.com …)`. Domains are
   grouped at **content-defined boundaries** (a per-domain hash marker), not by sorted
   position, so adding/removing one domain re-chunks only locally (re-syncing at the next
   marker) instead of shifting every downstream filter and churning the reconcile. The trade
   is packing density: with the marker rate set equal to the cap to keep the re-chunk region
   small, chunks average only ~2/3 of the cap (~6–7 of 10), so the standing set carries more
   filters than tight packing would — an accepted cost given the 450-filter soft-cap headroom.
4. **Soft cap ~450** filters (headroom below Gmail's 500).
5. **Best-effort + idempotent:** the local decision is the source of truth; filters are
   reconciled on a periodic client-side sync, retried on failure, and never duplicated.
   Sync state lives in the local `filterSyncState` store.
6. **Ownership tracking, not action-shape matching:** a filter is only ever deleted
   during reconciliation if its Gmail-assigned id is in `filterSyncState.managedFilterIds`
   (populated when this app creates a filter). Action shape alone ("Trash + skip inbox")
   is not proof of provenance — it's also a common hand-built Gmail filter — so a filter
   the user created outside the app is never touched, even if it happens to match a
   desired filter's criteria and action (#29). Symmetrically, `reconcileFilters` also
   never *creates* a duplicate for a desired filter that an untracked filter already
   covers — it surfaces that match instead, for confirm-first adoption (Decision 10, #80).
7. **Compiles the *effective* block set, with address-exception carve-outs.** The compiler
   resolves each sender's effective status via `resolveEffectiveDecision` (a domain decision
   overrides an address one unless the address is an exception, design-trust-decisions.md
   Decision 2) rather than reading raw `trustStatus`. A sender trusted at the domain level
   therefore gets **no** filter (#144). And when a domain is blocked but an address in it is
   trusted (an exception), the `*@domain` filter carries a Gmail **`criteria.negatedQuery`**
   exclusion (`from:(alice@d.com OR …)`), and the existing-mail sweep excludes the same
   addresses — so the exception's mail is never trashed (#145). This keeps the block a
   **single filter** (no de-aggregation, preserving the ~450 soft-cap headroom); a domain
   carrying exceptions gets its own filter rather than OR-combining (one exclusion per
   filter). The exclusion is part of the reconcile signature, so enforcement stays idempotent.

**Rationale:** Filters are the linchpin that makes a client-only app viable — they
provide durable, server-side enforcement with no backend of ours.

> **Parent-domain filter form (#136, ratified — #181 spike verified 2026-07-19).** A parent-domain
> rule (design-trust-decisions.md Decision 9) compiles to a **single bare-domain criterion
> `from:<eTLD+1>`** (no `*@` anchor). #181 confirmed on a real account: `from:apple.com` matched
> `@apple.com` **and every subdomain** (`id.apple.com`, `email.apple.com`, …), with no incidental
> over-match, and a subdomain query (`from:id.apple.com`) is a **precise subset** — so the parent
> filter covers current *and future* subdomains and an excepted subdomain carves out cleanly via
> `criteria.negatedQuery: from:<subdomain>` (point 7). **Caveat — trailing-label breadth:** Gmail
> matches `from:` on dot-separated tokens *from the left*, so `from:apple.com` also matches a
> *different registrable domain* whose leading labels are the eTLD+1 — `apple.com.au` (Apple
> Australia), `apple.com.br`, etc. **Trust side** is solved by the `tldts` covered-set guard (never
> *treat* a sibling as the parent). **Block side (#182)** keeps the broad filter — the breadth can be
> *intended* ("block this org everywhere") — but makes it safe: a **clear decision-time warning** of
> what will be caught (the observed senders the `from:<eTLD+1>` query actually matches, grouped by
> real registrable domain via `tldts`) plus **first-class exceptions**. The parent block's
> `negatedQuery` is **live-derived on every reconcile** from the effective status of every matched
> sender (like address exceptions #144/#145) — *not* a frozen decision-time list — so a later
> independent decision on a matched sibling is enforced automatically. **Constraints for #182:**
> Gmail caps a filter at **~1500 chars**, so a long exception list can't all live in one
> `negatedQuery` (query-simplify / split, cf. gmailctl); and the match surface may exceed trailing-
> label siblings if Gmail's `from:` term-matching prefix-stems (`applebees.com`?) — spot-check
> before finalising. See #182.

**Prior art — filter compilation & reconcile.** The compile → diff → apply model here isn't novel;
these were studied (none is a drop-in for a *client-only, browser* app, hence our own `compileFilters`
/ `reconcileFilters`, and none solves the eTLD+1/subdomain matching — that's `tldts` + Gmail's coarse
`from:`, #136):

- **[gmailctl](https://github.com/mbrt/gmailctl)** (Go) — declarative desired filters → diff against
  the account → apply via the API, with a **query simplifier** for Gmail's **~1500-char/filter limit**.
  Closest to our model; its char-limit handling informs the OR-combine (#152) and the parent-domain
  exception overflow (#182).
- **[gmail-britta](https://github.com/antifuchs/gmail-britta)** (Ruby) — a filter DSL whose negation
  / "unless" patterns map to our `criteria.negatedQuery` exceptions (#145).
- **Official [`googleapis`/`@googleapis/gmail`](https://github.com/googleapis/google-api-nodejs-client)**
  — the `settings.filters` resource + types; the authoritative shape our `GmailClient` port + `FilterSpec`
  mirror (we hand-roll the client because the app is client-only and talks to the API via `fetch`).
- **Sieve ([RFC 5228](https://www.rfc-editor.org/rfc/rfc5228))** — the standard mail-filtering language
  (tests/actions/`anyof`/`allof`); a conceptual reference if the rule model ever generalises.

### Decision 6: `GmailClient` as a port in `packages/core`

**Decision:** Define a framework-agnostic **`GmailClient` port** (TypeScript interface)
in `packages/core`, with a browser/`fetch` implementation. UI and product logic depend
on the interface, not the transport.

**Rationale:** Keeps `packages/core` presentation-agnostic (architecture.md §6) and
lets a **future mobile client swap the transport** (e.g. a native HTTP client with a
keychain-stored refresh token) without changing product logic (architecture.md §9).

### Decision 7: Learning scan — existing filters + read-weighted Spam/Trash

**Context:** To learn prior decisions (design-trust-decisions.md Decision 8), the client must
read beyond the Inbox — the account's filters and its Spam/Trash already encode "no" decisions.

**Decision:** In addition to the bounded **Inbox** metadata scan (Decision 3), a **learning
pass** reads:
- **`listFilters()`** — the account's native filters. A block-shaped filter (adds `TRASH`/
  `SPAM` or removes `INBOX` for a `from:` criterion) maps to a suggested Block on that
  sender/domain.
- A **bounded Spam and Trash metadata scan** (`in:spam` / `in:trash`, windowed like the Inbox
  scan). Trash results carry each message's **read-state** (the `UNREAD` label) so the trust
  layer can weight *unread-when-binned* as a signal and **ignore read-then-deleted**.

Metadata-only (labels + headers), same scope tier as the Inbox scan; results feed the
**per-sender decision** — the prior-block signal raises the trust score and surfaces flagged
siblings in the detail panel (design-trust-decisions.md Decision 8) — never an automatic mutation.

**Rationale:** Filters + Spam/Trash are where prior "no" decisions live; keeping it
metadata-only and windowed bounds cost while surfacing real intent.

### Decision 8: Count-only enforcement simulation (preview)

**Context:** design-trust-decisions.md Decision 7 requires an impact preview before applying,
which must not mutate anything.

**Decision:** Add a no-mutation **`simulate`** that counts what an `enforce` would do for a set
of pending decisions: messages that would be **archived / trashed / deleted**, filters that
would be **created / removed**, and messages that would be **rescued from Trash** on a reversal.
It reuses the same read paths as `enforce` (`listMessageIdsForSender`, `listFilters`) but calls
**no** mutating endpoint (`createFilter` / `deleteFilter` / `batchModifyMessages`). Future-volume
extrapolation is computed in `packages/core` from the sender's frequency / recency.

**A filter's criteria _is_ a Gmail search**, so the preview **dry-runs the rule read-only**:
running `from:<criteria>` (e.g. `from:*@retailco.com`) via `messages.list` returns the exact
message set the filter would act on — counts plus a metadata-only sample (sender / subject /
date) of what would be archived/deleted. This is the **validation**: Gmail has no filter dry-run
endpoint, but the search validates *what the rule matches* with zero side effects. Only the final
**commit** (`createFilter` → verify via `listFilters` → then message actions) mutates anything; a
failed create aborts **before** any deletion, and a created filter is rolled back on a later-phase
failure. For filter **optimisation** (Decision 9) the same search shows the delta between an old
per-address rule and a consolidated `*@domain` rule before the user agrees.

**Rationale:** Reuses the enforcement query paths for an honest, side-effect-free count that
doubles as the pre-apply validation; the destructive commit is gated on it.

### Decision 9: Filter-optimisation suggestions (confirm-first)

**Context:** A user's existing filters accrete cruft — many per-address rules where one domain
rule would do, duplicates, overlaps, over-broad matches.

**Decision:** Inspect existing filters and **suggest optimisations**: consolidate several
same-domain `from:addr` rules into one `*@domain` rule (reusing the domain-block threshold,
`DEFAULT_DOMAIN_BLOCK_THRESHOLD`), drop duplicate/overlapping/redundant rules, and flag
over-broad matches. Suggestions apply **only after explicit confirmation**, through the normal
filter-reconcile path (Decision 5); nothing changes silently.

**Rationale:** Fewer, cleaner rules are easier to reason about and stay within Gmail's filter
limits — but filters are the user's, so every change is opt-in.

### Decision 10: Confirm-first filter adoption (#80)

**Context:** Decision 5 point 6 fixed #29 by never inferring ownership from action shape — a
filter is only deleted if its id is tracked in `managedFilterIds`. That closed the delete-on-
first-sight risk but left a duplicate-create gap: if an untracked filter already has the exact
criteria + action a desired block filter needs (a filter built by hand, or created before
ownership tracking existed), `reconcileFilters` created a second, functionally-identical filter
alongside it rather than reusing the one already there.

**Decision:** `reconcileFilters` recognises this case and returns it in a new `adoptable` list —
it neither creates the duplicate nor auto-adopts the untracked filter. `suggestFilterAdoptions` /
`applyFilterAdoptions` (`adoptFilters.ts`) mirror Decision 9's suggest/apply split: adoption only
records the filter's id into `filterSyncState.managedFilterIds` (no Gmail mutation — the filter
already has the desired shape) once the user explicitly accepts the suggestion in Settings.
`applyFilterAdoptions` re-derives the desired filter set from the store's *current* blocked
senders/domains (via `compileFilters`) before recording, and records only the accepted adoptions
whose `from` still matches that set — closing the TOCTOU window where unblocking a sender between
"Check" and "Adopt" would otherwise let the next `enforce()` delete the adopted filter as an
unexpected loss (#89). It returns `{ adopted, skipped }` so the caller can surface any drops.

**Rationale:** Adoption and deletion are two doors into the same risk — once adopted, a filter
becomes eligible for deletion later if the matching sender/domain is unblocked, so guessing
ownership automatically is exactly as unsafe in this direction as in #29's. Requiring explicit
confirmation, like Decision 9's optimisation suggestions, closes the duplicate gap without
silently guessing provenance either way. Re-validating at apply time closes the same gap against
store state that changed *during* the confirmation window, not just before it.

## Interfaces

### `GmailClient` port (`packages/core`)

Interface-level contract only; implementations live alongside it. Token acquisition is
injected so the same port works for browser PKCE today and a native transport later.

```typescript
/** Short-lived bearer token + the scopes Google actually granted. */
interface AccessToken {
  value: string;
  expiresAt: number;        // epoch ms; in-memory only, never persisted
  grantedScopes: string[];
}

/** Tiered scopes; least-permission per architecture.md §6. */
type ScopeTier = 1 | 2 | 3;

interface ScanOptions {
  windowDays: number;       // default 30; bounded initial scan
  labelIds: string[];       // default ['INBOX']
}

/** Raw header/label projection — no body, no snippet (Decision 3). */
interface MessageMetadata {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;     // epoch ms
  headers: Record<string, string>; // From, To, Subject, Date, Message-ID,
                                    // Reply-To, List-Unsubscribe, List-Id,
                                    // Authentication-Results
}

interface SenderSummary {
  email: string;
  domain: string;           // denormalised for per-domain queries (§6)
  displayName?: string;
  category: string;         // from CATEGORY_* labels / List-* / frequency
  totalEmails: number;
  hasListUnsubscribe: boolean;
}

/** A change set since a stored historyId (§6). */
interface HistoryDelta {
  newHistoryId: string;
  addedMessageIds: string[];
  removedMessageIds: string[];
  labelChanges: { id: string; labelIds: string[] }[];
  stale: boolean;           // true ⇒ caller must run a bounded rescan
}

/** Action applied to existing mail (Tier 2). */
type MailAction =
  | { kind: 'trash'; messageIds: string[] }
  | { kind: 'archive'; messageIds: string[] }      // remove INBOX
  | { kind: 'relabel'; messageIds: string[]; add: string[]; remove: string[] };

/** Compiled native filter spec (Decision 5). */
interface FilterSpec {
  fromQuery: string;        // 'from:a@x.com' or 'from:(*@a.com OR *@b.com)'
  addLabelIds: string[];    // e.g. ['TRASH']
  removeLabelIds: string[]; // e.g. ['INBOX']
}

interface FilterReconcileResult {
  created: string[];        // Gmail filter IDs
  deleted: string[];
  totalFilters: number;     // current count, for the ~450 soft cap
  skippedAtCap: number;     // not created because the cap was reached
}

interface GmailClient {
  // Auth (browser PKCE today; injectable for a native transport later)
  authorize(tiers: ScopeTier[]): Promise<AccessToken>;
  getGrantedScopes(): Promise<string[]>;

  // Scan (metadata only)
  scanInbox(opts: ScanOptions): AsyncIterable<MessageMetadata>;
  syncSince(historyId: string): Promise<HistoryDelta>;

  // Senders
  listSenders(opts: ScanOptions): Promise<SenderSummary[]>;
  lookupContacts(emails: string[]): Promise<Record<string, boolean>>; // People API — deferred, not implemented in v1

  // Enforcement
  applyActions(actions: MailAction[]): Promise<void>;
  reconcileFilters(target: FilterSpec[]): Promise<FilterReconcileResult>;
}
```

| Method | Tier | Notes |
|--------|------|-------|
| `authorize` | 1+ | Requests only the named tiers; incremental escalation |
| `scanInbox` / `syncSince` | 1 | `format=metadata` only; `syncSince` returns `stale` on 404 |
| `listSenders` | 1 | Aggregates scan output into per-sender summaries |
| `lookupContacts` | 3 | **Deferred, not implemented in v1.** Planned: batched People API; result cached with 24h TTL |
| `applyActions` | 2 | `gmail.modify` |
| `reconcileFilters` | 2 | `gmail.settings.basic`; idempotent, respects ~450 cap |

## Configuration

No secrets and no server environment. Configuration is **build-time**, plus
**user settings stored on-device** (IndexedDB; architecture.md §8). All values are
client settings.

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `oauth.clientId` | string | – | Google OAuth **public** client ID (no secret) |
| `oauth.redirectUri` | string | app origin | PKCE redirect back to the SPA |
| `scan.windowDays` | number | `30` | Bounded initial-scan window |
| `scan.labelIds` | string[] | `['INBOX']` | Labels scanned |
| `sync.periodMinutes` | number | `60` | Periodic-sync interval (service worker where permitted) |
| `filters.softCap` | number | `450` | Stop creating filters near Gmail's 500 limit |
| `filters.maxDomainsPerFilter` | number | `10` | OR-combine ceiling per filter |
| `filters.domainBlockThreshold` | number | `3` | Senders-per-domain before a domain-level filter |
| `contacts.cacheTtlHours` | number | `24` | `inContacts` cache validity — **deferred setting; unused until `lookupContacts` ships** |
| `quota.slowAtFraction` | number | `0.8` | Slow scanning past this share of the per-user limit |

## Error Handling

Errors are surfaced to the UI; there is no server response envelope. The client maps
Gmail HTTP failures to typed errors and recovers locally.

| Error | Trigger | Recovery |
|-------|---------|----------|
| `GmailAuthExpired` | `401` / token expired in memory | Prompt re-consent (PKCE); resume from local state |
| `GmailScopeMissing` | Action needs an ungranted scope | Trigger incremental authorisation for the needed tier |
| `GmailHistoryStale` | `404` on History API | Transparent **bounded rescan**, reset `lastHistoryId` |
| `GmailRateLimited` | `429` / `403 rateLimitExceeded` | Client backoff; slow per `quota.slowAtFraction`; warn near cap |
| `GmailServerError` | `5xx` | Exponential backoff; retry on next sync |
| `GmailFilterCapReached` | At ~450 filters | Stop creating filters, prefer domain aggregation, surface warning |
| `GmailAccessRevoked` | User revoked in Google Account | Pause sync, keep all local data, offer one-click re-auth |

> Re-authentication is **non-destructive**: all senders, decisions, and analytics live
> in IndexedDB and survive any token loss (architecture.md §5).

## Examples

### Example 1: Bounded scan, then sender extraction

```typescript
const senders = new Map<string, SenderSummary>();
for await (const msg of gmail.scanInbox({ windowDays: 30, labelIds: ['INBOX'] })) {
  const from = parseAddress(msg.headers['From']);          // metadata only
  const domain = from.domain;                              // denormalised (§6)
  upsertSender(senders, from.email, domain, msg);          // category, counts, List-*
}
await repo.senders.bulkPut([...senders.values()]);
```

### Example 2: Incremental sync with transparent rescan

```typescript
const { lastHistoryId } = await repo.profile.get();
const delta = await gmail.syncSince(lastHistoryId);
if (delta.stale) {
  await rescanBounded({ windowDays: 30, labelIds: ['INBOX'] }); // 404 fallback
}
await repo.profile.patch({ lastHistoryId: delta.newHistoryId });
```

### Example 3: Compile blocks into filters and reconcile

```typescript
const blocked = await repo.senders.where('trustStatus').equals('blocked').toArray();
const target = compileFilters(blocked, {
  domainBlockThreshold: 3,   // 3+ senders ⇒ from:*@domain.com
  maxDomainsPerFilter: 10,   // OR-combine domains
  softCap: 450,
});
const result = await gmail.reconcileFilters(target);   // idempotent, best-effort
await repo.filterSyncState.patch({
  lastSyncAt: Date.now(),
  totalFilters: result.totalFilters,
});
```

## Migration Notes

This redesign **supersedes** the prior server-based Gmail integration. The following
are **removed** and have no client-only equivalent:

- Gmail **Watch API** setup/renewal, **Pub/Sub** topics, push **OIDC verification**.
- Server **token refresh**, KMS envelope encryption, stored refresh tokens.
- Server-side quota tiers, circuit breakers, and hourly batch filter-sync jobs.

They are replaced by **in-memory PKCE tokens**, **polling + periodic sync**, and
**client-side idempotent filter reconciliation**. There is no production data to
migrate (Alpha; see CLAUDE.md "No Backward Compatibility Required").

## Open Questions

- [ ] Service-worker **Periodic Background Sync** is Chromium-only and gated by site
      engagement — what is the fallback cadence on Firefox/Safari (open-on-launch only)?
- [ ] How aggressively should the client estimate Gmail per-user quota when Google does
      not expose remaining quota directly — fixed unit costs, or adaptive backoff only?
- [ ] People API contact lookup batching and quota interplay with the Gmail scan budget.

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-07-19 | **Prior-art note (Decision 5):** record the filter compile/diff/apply prior art studied — `gmailctl` (Go; closest model + ~1500-char query simplifier), `gmail-britta` (Ruby DSL; negation patterns), official `googleapis` filter types, and Sieve (RFC 5228). None is a drop-in for a client-only browser app, hence our own compiler. | Claude |
| 2026-07-19 | **Decision 5 note (#136, #181 spike verified):** parent-domain enforcement is a **single bare-domain `from:<eTLD+1>` filter** — verified on a real account to match a domain + all subdomains (current + future); excepted subdomains carve out via `negatedQuery: from:<subdomain>`. Trust side guarded client-side by `tldts`. **Block-side trailing-label breadth** (`from:apple.com` also matches sibling domains like `apple.com.au`) kept broad-by-design with **warnings + exceptions**, mindful of Gmail's ~1500-char/filter limit (#182). Pairs with design-trust-decisions.md Decision 9. | Claude |
| 2026-07-18 | **Decision 5 point 3 (#152):** OR-combine domain chunks are now cut at **content-defined boundaries** (a per-domain hash marker) instead of by sorted position, so adding/removing one domain re-chunks only locally rather than shifting every downstream filter and churning the reconcile. Trade-off: with the marker rate set equal to the cap for tight re-chunk locality, chunks average ~2/3 of the ≤10 cap (~6–7 domains), so more filters are used — accepted given the 450-filter soft-cap headroom. | Claude |
| 2026-07-18 | **Decision 5 point 7 (#144, #145):** enforcement compiles from the *effective* block set — `resolveEffectiveDecision` (Decision 2) resolves domain overrides + exceptions, not raw `trustStatus`. A domain-trusted sender gets no filter (#144); a blocked domain with a trusted address exception carries a `criteria.negatedQuery` carve-out (and the existing-mail sweep excludes it), kept as one filter with the exclusion in the reconcile signature (#145). | Claude |
| 2026-07-17 | **Decision 7 doc-sync (#96):** the learning-scan results now feed the **per-sender decision** (prior-block signal → trust score + flagged-sibling surfacing, design-trust-decisions.md Decision 8), not the removed standalone confirm-first import. Filter adoption stays the existing **Decision 10** (`suggestFilterAdoptions`, #80). | Claude |
| 2026-07-16 | Update **Decision 10** to describe `applyFilterAdoptions`'s apply-time re-validation: it re-derives the desired filter set from current blocked senders/domains and records only adoptions that still match, returning `{ adopted, skipped }` — closes a TOCTOU gap where unblocking a sender during the confirm window could otherwise cause the next `enforce()` to delete the adopted filter (#89). | Claude |
| 2026-07-14 | Add **Decision 10: confirm-first filter adoption** (#80) — `reconcileFilters` no longer creates a duplicate filter when an untracked existing filter already matches a desired one; it surfaces the match in a new `adoptable` list instead, and `suggestFilterAdoptions`/`applyFilterAdoptions` let the user opt in before its id is tracked as managed. Closes the duplicate-create gap left by Decision 5 point 6's #29 fix without inferring ownership automatically in either direction. | Claude |
| 2026-07-14 | Resolve the filter-ownership open question: Decision 5 adds a point 6 — `reconcileFilters` now gates deletion on `filterSyncState.managedFilterIds` (an id set populated when this app creates a filter), not on matching the block action shape, so a user's own hand-built "Trash + skip inbox" filter is never silently deleted (#29). | Claude |
| 2026-07-12 | Clarify that Tier-3 `contacts.readonly`/`lookupContacts`/`contacts.cacheTtlHours` are **deferred, not implemented** in v1 — matches the code (`GmailClient.ts` `SCOPES_BY_TIER`) and cross-links to ROADMAP.md's Deferred table. Documentation-only; no scope or code change. | Claude |
| 2026-07-05 | Implement the **transport-level retry/backoff** the error table already specifies (`GmailRateLimited` 429 / 403 `rateLimitExceeded`, `GmailServerError` 5xx, 408): a shared `fetchWithRetry` wrapper honours `Retry-After` and otherwise uses exponential backoff + full jitter, so transient limits self-heal instead of surfacing as errors. Applied to the Gmail and Drive browser adapters. | Claude |
| 2026-07-05 | Add **Decisions-milestone** capabilities: Decision 7 **learning scan** (read `listFilters` + a bounded read-weighted Spam/Trash scan to surface prior "no" decisions); Decision 8 **count-only enforcement simulation** (no-mutation impact preview + future extrapolation); Decision 9 **filter-optimisation suggestions** (consolidate/dedupe/tighten, confirm-first). | Claude |
| 2026-06-28 | Full rewrite for client-only, local-first, no-backend PWA architecture: browser PKCE OAuth, metadata-only scan, polling + periodic sync (no push), native-filter compilation, and the `GmailClient` port in `packages/core`. Supersedes the prior server-based design. | Claude |
