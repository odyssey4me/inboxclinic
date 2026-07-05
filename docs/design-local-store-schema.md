# Local Store Schema (On-Device)

> **Status:** Draft
>
> **Last Updated:** 2026-06-28
>
> Implements: [architecture.md](architecture.md) §5 (Data & Privacy Boundaries),
> §6 (Core Interfaces).

## Overview

All user data lives **on the device** in **IndexedDB**, accessed through
[Dexie](https://dexie.org/). There is no server and no cloud datastore. This doc
defines the object stores, key encoding, indexes, the repository interface that
isolates the rest of the app from Dexie, and the export/delete and versioning
conventions.

The repository interface is a **port** in `packages/core`: UI and logic depend on
it, not on Dexie directly, so a future mobile client (architecture §9) can supply
a different backing store (e.g. SQLite) without touching product logic.

## Architecture Reference

This design implements the following sections of [architecture.md](architecture.md):

| Section | Title | Relevance |
|---------|-------|-----------|
| 5 | Data & Privacy Boundaries | On-device entities and invariants; privacy posture (data never leaves the device; export = dump, delete = clear + revoke); the deferred aggregate-contribution seam |
| 6 | Core Interfaces | The store port: persist/query the user's data on-device, plus export, import (restore), and wipe |

## Design Decisions

- **Dexie over raw IndexedDB** — concise schema/versioning, typed tables, async
  iteration; thin enough to stay un-locked-in.
- **No sync engine** — under the local-first model the user's data has *no cloud
  counterpart*, so a CRDT/replication layer would be dead weight. A plain local
  store suffices (architecture §2).
- **Single-device** is the accepted v1 trade-off; true multi-device sync is out of
  scope, though **Drive backup/restore** (architecture §5) covers moving to a new
  device.
- **Stable, collision-free keys** — records are keyed by a **URL-safe Base64 of the
  lowercased email/domain** (no padding), so `foo.bar@x.com` and `foo_bar@x.com`
  never collide.

## Interfaces

### Object stores

| Store | Primary key | Indexes (examples) | Purpose |
|-------|-------------|--------------------|---------|
| `profile` | `googleEmail` | — | Single record: account, onboarding status, `lastHistoryId`, counts, `privacy.contributeToAggregate` (default `true`). |
| `senders` | `id` (b64url email) | `domain`, `trustStatus`, `category`, `updatedAt` | Per-sender stats, signals, decision, bounded `trustHistory` (≤50), `decisionContext`. |
| `domains` | `id` (b64url domain) | `trustStatus`, `updatedAt` | Per-domain aggregates, decision scope, `exceptionAddresses[]`. |
| `prompts` | `id` | `priorityScore`, `batchGroupId`, `expiresAt`, `resolvedAt` | Pending trust prompts; 30-day TTL. |
| `analyticsDaily` | `date` (YYYY-MM-DD) | — | Daily counters. |
| `analyticsMonthly` | `month` (YYYY-MM) | — | Monthly counters, `inboxHealthScore`, `estimatedTimeSaved`, `achievements[]`. |
| `filterSyncState` | `key` (singleton) | — | Native-filter manifest + pending reconciliations + last sync time. |
| `settings` | `key` | — | User-controlled preferences & opt-ins (theme, `contributeToAggregate`; architecture §8). |

Field-level shapes follow architecture.md §5. `decisionContext.collectiveScore` and
sibling network fields are present but `null` until the aggregate exists.

### Repository port (in `packages/core`)

A minimal, store-agnostic interface — illustrative TypeScript:

```ts
interface Store {
  profile: { get(): Promise<Profile | undefined>; put(p: Profile): Promise<void> };
  senders: Repo<Sender>;
  domains: Repo<Domain>;
  prompts: Repo<Prompt> & { byPriority(limit: number): Promise<Prompt[]> };
  analytics: { day(date: string): Promise<DailyAnalytics | undefined>; /* … */ };
  filterSync: { get(): Promise<FilterSyncState>; put(s: FilterSyncState): Promise<void> };
  exportAll(): Promise<Uint8Array>;            // JSON blob of every store (export / backup)
  importAll(blob: Uint8Array): Promise<void>;  // replace all stores (restore)
  wipeAll(): Promise<void>;                     // clear all stores (delete-my-data)
}

interface Repo<T> {
  get(id: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  bulkPut(values: T[]): Promise<void>;
  query(filter: Partial<T>): Promise<T[]>;
  delete(id: string): Promise<void>;
}
```

The Dexie implementation lives in `apps/web` (or an adapter package); `packages/core`
logic depends only on `Store`.

### Key encoding

```ts
const keyFor = (s: string) =>
  base64UrlNoPad(utf8(s.trim().toLowerCase()));   // e.g. "company.com" → "Y29tcGFueS5jb20"
```

## Configuration

- **Dexie version number** is bumped on any schema change; migrations are declared
  with `db.version(n).stores({...}).upgrade(...)`. Alpha permits destructive
  migrations (architecture constraints), but prefer a transform where cheap.
- **TTL sweep:** prompts past `expiresAt` are pruned on app start and after sync.

## Error Handling

- Treat IndexedDB as fallible: wrap writes; surface a non-blocking toast on quota or
  transaction failure; never lose a recorded decision silently (retry on next open).
- A corrupt/incompatible DB version offers the user an **export-then-reset** path
  rather than failing closed.

## Examples

- **Export:** `store.exportAll()` → download as `inbox-clinic-export-<date>.json`.
- **Back up to Drive (opt-in):** `store.exportAll()` → upload/overwrite a visible
  `Inbox Clinic Backup.json` in the user's own Drive via the `drive.file` scope
  (architecture §5). Manual in v1; optional periodic later.
- **Restore from Drive:** download the file → `store.importAll(blob)` (replaces local
  data after a warning). Backup/restore, not sync.
- **Delete my data:** `store.wipeAll()` then revoke the app's Google access token.

## Open Questions

- Encrypt the IndexedDB payload at rest (e.g. WebCrypto) for shared-device cases, or
  rely on OS/browser profile isolation? (Leaning: optional, off by default in v1.)
- Exact retention for resolved prompts/analytics before local pruning.

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-06-28 | Initial draft (client-only PWA). | Claude |
