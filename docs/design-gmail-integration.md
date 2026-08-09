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
6. **Only reason about filters we fully model.** `FilterSpec` represents `from` and
   `excludeFrom`; Gmail also matches on `to`, `subject`, `query` and more. A filter carrying
   any of those is **foreign by construction** — the app only ever creates filters from a
   `FilterSpec`, so it cannot be ours whatever `managedFilterIds` says — and its signature is
   not its meaning: `from:x@y.com AND subject:foo` signs identically to a plain block on
   `x@y.com` while doing something far narrower. Such a filter is therefore never adopted,
   never deleted, never a duplicate of a rule that merely looks like it, never counted as
   coverage that makes another rule redundant, and never read as evidence of a prior decision.
   Treating one as understood risks deleting a rule the user built, and reporting a sender as
   blocked when only part of its mail is (#212). The provider adapter reports which criteria
   it had to drop, so the projection's incompleteness is visible to the code rather than
   assumed away.
7. **Ownership tracking, not action-shape matching:** a filter is only ever deleted
   during reconciliation if its Gmail-assigned id is in `filterSyncState.managedFilterIds`
   (populated when this app creates a filter). Action shape alone ("Trash + skip inbox")
   is not proof of provenance — it's also a common hand-built Gmail filter — so a filter
   the user created outside the app is never touched, even if it happens to match a
   desired filter's criteria and action (#29). Symmetrically, `reconcileFilters` also
   never *creates* a duplicate for a desired filter that an untracked filter already
   covers — it surfaces that match instead, for confirm-first adoption (Decision 10, #80).
8. **Compiles the *effective* block set, with address-exception carve-outs.** The compiler
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
> independent decision on a matched sibling is enforced automatically. Derivation is cheap (it reads
> the locally-observed sender set already in hand, no extra Gmail query) and, like the address
> exclusion in point 8, the `negatedQuery` is **part of the reconcile signature** — so "live-derived"
> rewrites the filter only when the derived exclusion set actually changes, not on every reconcile
> tick. **Constraints for #182:**
> Gmail caps a filter at **~1500 chars**, so a long exception list can't all live in one
> `negatedQuery` (query-simplify / split, cf. gmailctl); and the **match is whole-token,
> left-anchored** — a spot-check (real account, 2026-07-19; `apple.com` vs `applebees.com`, not
> documented Gmail behaviour) found `from:<domain>` reaches true subdomains (`id.apple.com`) and any
> domain whose *leading dot-bounded labels* are the eTLD+1 (`apple.com.au`), but **not** partial-label
> prefix lookalikes (`applebees.com` is *not* matched). So the surface is **not** enumerable in
> advance (someone could register `apple.com.x.net`), but the *warning* lists the **finite observed**
> matched senders (`tldts`-grouped) — and the `tldts` guard/live `negatedQuery` are the safety net
> regardless of the exact surface, so the confidence level here isn't load-bearing. See #182.
>
> **Exception-overflow handling (~1500-char criteria limit) — parent blocks proposed (#182);
> exact-domain blocks implemented (#191).** *Any* domain-scope block's exclusions live in one
> `negatedQuery`, which shares the filter's ~1500-char criteria budget — the exact-domain blocks
> shipped today (point 7) as much as the parent blocks of Decision 9. Over the budget, Gmail
> **rejects the filter outright**, and the rejection is indistinguishable from a transient
> failure, so the same doomed rule is retried on every sync while the domain stays unblocked
> (#191). Keep it bounded, deterministically (part of the reconcile signature, so it stays
> idempotent):
> 1. **Collapse to the broadest exclusion** — when a whole subdomain/sibling is excepted, exclude it
>    as `*@sub.example.com` (one short token) rather than enumerating its addresses.
> 2. **If the derived `negatedQuery` still exceeds the budget, degrade *that rule* to the enumerate
>    form.** For a **parent** rule: emit `*@<eTLD+1>` for the **bare apex** **plus** one
>    `*@<subdomain>` per still-blocked observed subdomain, instead of the single broad
>    `from:<eTLD+1>` + `negatedQuery` (an excepted subdomain then simply gets no filter). The apex
>    filter is explicit so apex mail is never dropped. For an **exact-domain** rule there is no
>    sub-structure to keep: emit one `from:<address>` filter per still-blocked observed sender and
>    **no** `*@domain` filter at all — a plain domain filter would trash exactly the addresses the
>    carve-out was protecting. Precise, but it **loses the future-new-sender/subdomain guarantee for
>    that rule** — surface the caveat ("covers what has been seen so far") on it. Rare — only when
>    one rule accumulates enough exceptions to overflow; the common case stays the single broad
>    filter. If no observed member list is available to enumerate from, emit **nothing** for that
>    rule and report it as unblocked — better an honest gap the user is told about than a filter
>    that can never be created.
> 3. **Hysteresis** so a rule near the boundary doesn't flip broad↔enumerate (tearing down/rebuilding
>    1↔N filters) on a single added/removed exception: degrade at the limit, and only re-promote to
>    the broad form once the derived `negatedQuery` is comfortably back under budget (margin, not the
>    exact threshold). **Not yet implemented** — the compiler is pure and doesn't know which form a
>    rule currently takes, so hysteresis needs the reconcile side to feed that back in; #191 shipped
>    the single deterministic threshold first, since flapping costs filter churn while an
>    unbounded query costs the block entirely.
> 4. **Soft cap:** the enumerate form's `*@subdomain` filters count against the ~450 soft cap like any
>    other; a pathological rule (many blocked subdomains) is bounded by the **existing soft-cap
>    behaviour** (`capReached`/`skippedAtCap` surfaced), not a special case — it's just the rule that
>    consumes the most of the budget.

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

**Ownership gate (#190).** "Through the normal reconcile path" includes its provenance rule
(Decision 5 point 7, #29): only a filter whose id is in `managedFilterIds` is ever *offered* for
removal. The block action shape is also what a hand-built Gmail filter looks like, so an
untracked filter is left alone however textbook a duplicate it is — it may still *count* as
coverage (a hand-built `*@domain` rule does make an address rule redundant) and it still
appears in the account's filter total, but it is never the thing deleted. Untracked rules also
don't count towards `DEFAULT_DOMAIN_BLOCK_THRESHOLD`, so a pile of the user's own address
filters is never traded for one broad rule they didn't ask for.

**Ownership bookkeeping (#202).** The reconcile path's provenance rule runs in both directions:
applying a consolidation records the replacement `*@domain` filter's id in `managedFilterIds`
and drops the ids it removed, in one write. A replacement left untracked would be *this app's own*
broadest rule with no owner — never cleanable by reconcile (Decision 5 point 7), invisible to
this tool's later passes, and matching a desired filter with no managed id, so Decision 10 would
offer to "adopt" a filter the app created moments earlier. Because consolidation reuses
`DEFAULT_DOMAIN_BLOCK_THRESHOLD`, the tidied set is also what the next reconcile compiles from
the standing decisions, so the tidy-up survives the next sync instead of being churned back.

**Rationale:** Fewer, cleaner rules are easier to reason about and stay within Gmail's filter
limits — but filters are the user's, so every change is opt-in, and the ones this app didn't
create are out of bounds entirely.

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

The **authoritative interface is the source file** —
[`packages/core/src/ports/GmailClient.ts`](../packages/core/src/ports/GmailClient.ts). Its
methods, the types they exchange (`AccessToken`, `MessageMeta`, `FilterSpec`, `NativeFilter`,
`HistoryList`, …) and their doc comments **are** the contract. This section deliberately does
not restate them in an illustrative code block, because a copy drifts silently: an earlier one
outlived the real port by a whole milestone and sent readers implementing against method names
that existed nowhere in the codebase (#193). What belongs here instead is what the code cannot
say for itself — which scope tier each capability needs, and which decision above it serves.

Implementations are adapters: a browser PKCE/GIS + `fetch` client in `apps/web`, and an
in-memory fixture (`packages/core/src/demo/inMemoryGmail.ts`, exported to tests as
`MockGmailClient`). Token acquisition sits behind the port, so the same core logic works for
browser PKCE today and a native transport later.

| Capability (port methods) | Tier | Notes |
|---------------------------|------|-------|
| Auth — `authenticate`, `getAccessToken` | 1+ | Requests only the named tiers; incremental escalation (Decision 2). The token is held in memory only (Decision 1) |
| Identity — `getAccountEmail` | 1 | The signed-in address; the `profile` store's primary key |
| Scan — `listMessageIds`, `getMessageMeta` | 1 | Bounded `messages.list` query, then `format=metadata` fetches — never bodies or snippets (Decision 3) |
| Incremental sync — `listHistory`, `getLatestHistoryId` | 1 | `users.history.list` from the stored marker; a marker Gmail rejects as too old raises `StaleHistoryError`, and the caller falls back to a bounded rescan (Decision 4) |
| Filters — `listFilters`, `createFilter`, `deleteFilter` | 2 | `gmail.settings.basic`. `createFilter` resolves to the created filter **with its id** — recording that id is what makes the filter ours to reconcile later (Decision 5 point 6) |
| Existing mail — `batchModifyMessages`, `listMessageIdsForSender` | 2 | `gmail.modify`; archive / trash / Trust-rescue label edits over a bounded id set, with a domain sweep able to exclude its trusted exceptions |
| Contacts lookup | 3 | **Deferred, not implemented in v1** — there is no port method. Planned: batched People API, cached with a 24h TTL |

**What is *not* on the port.** Compiling decisions into a desired filter set and diffing it
against the account are **pure functions**, not provider calls: `compileFilters` and
`reconcileFilters` live in `packages/core/src/enforcement/compileFilters.ts` and produce a
`FilterSpec[]` and a `{ toCreate, toDelete, adoptable }` plan. The port only performs the
resulting list/create/delete. Keeping the diff pure is what lets the soft cap, the OR-combine
chunking, and the ownership rules of Decision 5 be tested without a transport, and keeps them
out of every adapter.

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
// packages/core/src/scan/runScan.ts — bounded query, then metadata-only fetches.
const query = buildScanQuery(windowDays, labelIds);        // e.g. 'in:inbox newer_than:30d'
const ids = await client.listMessageIds(query, maxMessages);
// Best-effort per message: one that moved or was deleted since listing must not abort the scan.
const settled = await Promise.allSettled(ids.map((id) => client.getMessageMeta(id)));
const metas = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);

const { senders, domains } = extractSenders(metas, now);   // headers only, never bodies
await store.senders.bulkPut(senders);
await store.domains.bulkPut(domains);
```

### Example 2: Incremental sync with transparent rescan

```typescript
// packages/core/src/scan/incrementalSync.ts — a stale marker is a typed error, not a flag.
const profile = await store.profile.get();
let history;
try {
  history = await client.listHistory(profile.lastHistoryId, { labelId: "INBOX" });
} catch (error) {
  if (error instanceof StaleHistoryError) return fullSync(...);  // 404 ⇒ bounded rescan
  throw error;
}
// Claim the new marker before merging, so a retry resumes instead of re-applying deltas (#48).
await store.profile.put({ ...profile, lastHistoryId: history.historyId });
```

### Example 3: Compile blocks into filters and reconcile

```typescript
// packages/core/src/enforcement/enforce.ts — pure compile + diff, then port calls.
const compiled = compileFilters(await effectiveBlockedSenders(store), blockedDomains, {
  domainBlockThreshold: 3,   // 3+ blocked senders ⇒ from:*@domain.com
  maxDomainsPerFilter: 10,   // OR-combine domains at content-defined boundaries
  softCap: 450,
});
const existing = await client.listFilters();
const { toCreate, toDelete } = reconcileFilters(compiled.filters, existing, managedFilterIds);

for (const spec of toCreate) managedFilterIds.add((await client.createFilter(spec)).id);
for (const id of toDelete) { await client.deleteFilter(id); managedFilterIds.delete(id); }
await store.filterSync.put({ ...previousSync, managedFilterIds: [...managedFilterIds] });
```

> Illustrative, not copy-paste: error handling and the best-effort per-filter failure
> collection are elided. The linked modules are the real thing.

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
| 2026-08-09 | **Decision 5 point 6 — only reason about filters we fully model (#212):** a real account turned up filters matching on `to`/`subject`/`query`, which `FilterSpec` drops. Two such filters signed identically and the tidy-up offered to delete one as a duplicate; a `from:X AND subject:Y` rule also signs like a plain block on X, so adoption would claim it and reconcile could later delete it. Such filters are now foreign by construction — never adopted, deleted, deduplicated, counted as coverage, or read as a prior decision — and the adapter reports which criteria it dropped. Renumbers the former points 6–7 to 7–8. | Claude |
| 2026-08-09 | **Decision 5 exception-overflow generalised + implemented for exact-domain blocks (#191):** the ~1500-char criteria budget binds *any* domain-scope carve-out, not just the parent blocks of #182 — today's shipped `*@domain` + `negatedQuery` path could already build a rule Gmail rejects, retried forever while the domain stayed unblocked. Spelled out the exact-domain enumerate form (one `from:<address>` per still-blocked observed sender, **no** `*@domain` filter, since a plain one would trash the excepted addresses), the "emit nothing and report it" fallback when no member list is available, and marked hysteresis (point 3) as not yet implemented — it needs the reconcile side to feed back which form a rule currently takes. | Claude |
| 2026-08-09 | **Decision 9 ownership bookkeeping (#202):** state that the provenance rule runs in both directions — applying a consolidation records the replacement `*@domain` filter's id in `managedFilterIds` and drops the removed ids in the same write, so the app's own broadest rule is never untracked from birth (uncleanable by reconcile, and offered back via Decision 10 adoption). Note that consolidation reusing `DEFAULT_DOMAIN_BLOCK_THRESHOLD` is what keeps the tidy-up from being churned back by the next reconcile. | Claude |
| 2026-08-09 | **Interfaces + Examples de-drifted (#193):** the illustrative `GmailClient` block described a port that no longer existed (`authorize`/`scanInbox`/`syncSince`/`listSenders`/`applyActions`/`reconcileFilters`, plus a `FilterSpec` of `{ fromQuery, … }`), and the three examples called the same absent methods. Replaced the block with a link to the authoritative source (`packages/core/src/ports/GmailClient.ts`) plus a capability/tier table that carries what the code can't — scope tier and originating decision; rewrote the examples against the real API; and stated explicitly that `compileFilters`/`reconcileFilters` are pure functions in `enforcement/compileFilters.ts`, not port methods. | Claude |
| 2026-08-08 | **Decision 9 ownership gate (#190):** spell out that "through the normal reconcile path" carries Decision 5 point 6's provenance rule — `suggestFilterOptimisations` only ever offers a filter for removal if its id is in `managedFilterIds`, so the #29 guarantee (a hand-built "Trash + skip inbox" filter is never deleted) holds on the optimisation path too. Untracked filters still count as *coverage* but not towards `DEFAULT_DOMAIN_BLOCK_THRESHOLD`. | Claude |
| 2026-07-19 | **Decision 5 note (#182):** specify parent-block **exception-overflow handling** for Gmail's ~1500-char criteria limit — collapse to the broadest exclusion (`*@sub`), else degrade *that rule* to enumerated filters (**explicit `*@<eTLD+1>` apex** + `*@subdomain` per still-blocked subdomain; loses the future-subdomain guarantee, surfaced as a caveat). Added **hysteresis** (no broad↔enumerate flip on one exception) and noted the enumerate filters count against the ~450 soft cap (existing `capReached` bounds a pathological rule). Also reframed the match surface (whole-token/left-anchored, not enumerable-in-advance; the warning lists observed matches; one spot-check, not documented Gmail behaviour). | Claude |
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
