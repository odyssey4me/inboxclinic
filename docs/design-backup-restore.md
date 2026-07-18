# Design: Backup & Restore (Google Drive)

> **Status:** Draft (Alpha)
>
> **Last Updated:** 2026-07-05

## Overview

Inbox Clinic stores **all** user data on-device in IndexedDB (see
[design-local-store-schema.md](design-local-store-schema.md)). Most of that data is
reconstructible by re-scanning the inbox — but **user decisions are not**, so
architecture.md §5 makes **backup a first-class capability**. This document owns the
**opt-in backup/restore feature**: how the on-device store is copied to, and recovered
from, the **user's own Google Drive**.

It is a **separate concern from Gmail integration** — a different Google API behind its
own port — so it lives in its own doc rather than in
[design-gmail-integration.md](design-gmail-integration.md). It establishes:

- The `BackupClient` **port** (in `packages/core`) and its browser Drive adapter.
- The least-permission **`drive.file`** scope and incremental consent.
- A single, user-visible backup file and its find-or-create/update semantics.
- **Restore = replace-local, not sync.**

It reuses the store's existing `exportAll()` / `importAll()` primitives
([design-local-store-schema.md](design-local-store-schema.md)) — this feature adds the
**transport**, not the serialisation.

## Architecture Reference

This design implements the following sections of [architecture.md](architecture.md):

| Section | Title | Relevance |
|---------|-------|-----------|
| 5 | Data & Privacy Boundaries | Backup is first-class; user-owned data may go to the user's *own* Drive; still no service-side custody |
| 6 | Core Interfaces | Realises the Store's `export`/`import` via a new provider port (`BackupClient`); least-permission scope |
| 8 | User Settings & Opt-in Features | Backup is **opt-in, default off**, controlled entirely by the user on-device |

## Design Decisions

### Decision 1: A separate `BackupClient` port

**Context:** Backup talks to **Google Drive**, not Gmail. The existing `GmailClient`
port ([design-gmail-integration.md](design-gmail-integration.md)) is Gmail-shaped.

**Decision:** Define a small, framework-agnostic **`BackupClient` port** in
`packages/core`, with a browser Drive-REST adapter in `apps/web`. Product logic depends
on the interface, not on Drive.

**Rationale:** Keeps `GmailClient` purely Gmail; gives backup a single authoritative
contract; and lets a future mobile client swap the transport (architecture.md §9) — e.g.
a native file picker or a different provider — without touching orchestration.

**Alternatives considered:**
- Fold Drive methods + a `drive.file` tier into `GmailClient` — rejected; mixes two
  Google APIs behind a Gmail-named port.
- Generic "cloud storage" abstraction over several providers — rejected as premature;
  Drive is the only v1 target (YAGNI).

### Decision 2: Least-permission `drive.file`, opt-in and incremental

**Context:** Drive access is sensitive. The user must trust that the app cannot read the
rest of their Drive.

**Decision:** Request only **`drive.file`** — which grants access **only to files the
app itself creates or opens** — and only when the user **enables backup** (default off),
via **incremental authorisation** (same GIS pattern as the Gmail tiers).

| Scope | Grants | Requested |
|-------|--------|-----------|
| `drive.file` | Read/write **only** app-created files | On backup opt-in |

**Rationale:** `drive.file` is the minimum that supports a user-visible backup file and
**cannot** enumerate or read the user's other Drive content — honouring data
minimisation (architecture.md §5). Opt-in + default-off matches architecture.md §8. The
hosted instance runs in testing mode with a ≤100-user allowlist, so no verification is
required (architecture.md §7).

**Alternatives considered:**
- `drive.appdata` (hidden app-data folder) — rejected; the backup would be invisible to
  the user, weakening the "user owns their data" posture. A visible file is intentional.
- Full `drive` scope — rejected; grossly over-permissioned.

### Decision 3: A single, user-visible backup file, updated in place

**Decision:** Maintain **one** file named **`Inbox Clinic Backup.json`** in the user's
Drive. Back-up is **find-or-create by name, then overwrite**: if a prior backup exists
(matched by the stored `fileId`, else by name), **update** it in place; otherwise
**create** it. The stored `fileId` is cached in the `settings` store.

**Rationale:** One visible, in-place file is transparent (the user can see and manage it)
and avoids Drive clutter. `drive.file` keeps app-created files user-visible while denying
access to everything else.

### Decision 4: Manual v1; restore is replace-local, not sync

**Context:** True multi-device sync is out of scope (design-local-store-schema.md);
backup exists for durability and device migration.

**Decision:** v1 is **manual only** — a "Back up now" action and a "Restore from backup"
action. **Restore replaces all local data** via `Store.importAll()` after an explicit
user confirmation (a destructive-action warning). There is **no merge and no continuous
sync**. Periodic auto-backup is deferred to a later milestone.

Because restore is destructive, `importAll` **validates the blob before touching the store**:
both Store implementations run the shared, pure `parseStoreDump` gate first, so a truncated /
corrupt / wrong-shape file throws a typed `InvalidBackupError` and **leaves the existing data
intact** rather than wiping first and failing mid-write. Validation is shape/safety only (each
table is an array of objects), fuzzed at the boundary (design-testing.md, #166).

**Rationale:** Manual, replace-local is simple, predictable, and sufficient for "move to
a new device" / "recover after eviction". Merge/sync would reintroduce conflict handling
that the local-first model deliberately avoids.

### Decision 5: Local store is the source of truth; best-effort transport

**Decision:** The on-device store is authoritative. Backup is **best-effort**: failures
surface to the UI and are safely retryable (re-running overwrites the same file). A
missing/renamed remote file on restore is a typed, recoverable condition — never a crash.

## Interfaces

### `BackupClient` port (`packages/core`)

Interface-level contract only; the browser Drive adapter lives in `apps/web`. The port
carries **opaque blobs** — it neither serialises nor interprets store contents (that is
`Store.exportAll`/`importAll`).

```typescript
/** Identity + metadata for the single backup file. */
interface BackupFile {
  id: string;           // Drive file id
  name: string;         // always BACKUP_FILE_NAME
  modifiedTime: string; // RFC 3339, from Drive
}

interface BackupClient {
  /** Ensure a valid drive.file token (incremental consent on first use). */
  authorize(): Promise<void>;
  /** Locate the existing backup file by name; undefined if none exists yet. */
  findBackupFile(): Promise<BackupFile | undefined>;
  /** Create the backup file with the given bytes; resolves to its identity. */
  createBackupFile(blob: Uint8Array): Promise<BackupFile>;
  /** Overwrite an existing backup file's contents (media update). */
  updateBackupFile(id: string, blob: Uint8Array): Promise<void>;
  /** Download a backup file's raw bytes for restore. */
  downloadBackupFile(id: string): Promise<Uint8Array>;
}

/** Fixed, user-visible file name in the user's own Drive. */
export const BACKUP_FILE_NAME = "Inbox Clinic Backup.json";

/** Least-permission Drive scope: only app-created files (Decision 2). */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
```

| Method | Drive endpoint | Notes |
|--------|----------------|-------|
| `authorize` | GIS token client (`drive.file`) | Incremental; triggered by opt-in |
| `findBackupFile` | `files.list?q=name='…' and trashed=false` | Returns newest match or `undefined` |
| `createBackupFile` | `POST upload/drive/v3/files` (multipart) | Sets name + JSON media |
| `updateBackupFile` | `PATCH upload/drive/v3/files/{id}` (media) | In-place overwrite |
| `downloadBackupFile` | `GET files/{id}?alt=media` | Raw bytes |

### Orchestration (`packages/core`)

Pure functions over the `BackupClient` and `Store` ports (no transport specifics):

```typescript
/** exportAll → find-or-create → upload → record lastBackupAt + fileId. */
backupToDrive(backup: BackupClient, store: Store): Promise<BackupResult>;
/** find → download → importAll (caller confirms the replace-local warning first). */
restoreFromDrive(backup: BackupClient, store: Store): Promise<RestoreResult>;
```

## Configuration

No secrets and no server environment — configuration is **user settings stored
on-device** (the `settings` store; architecture.md §8).

### Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `backup.enabled` | boolean | `false` | Opt-in master switch; enabling triggers `drive.file` consent |
| `backup.lastBackupAt` | number \| null | `null` | Epoch ms of the last successful backup |
| `backup.fileId` | string \| null | `null` | Cached Drive id of `Inbox Clinic Backup.json` |

## Error Handling

Errors surface to the UI; the client maps Drive HTTP failures to typed errors and
recovers locally. The local store is never mutated by a failed backup.

| Error | Trigger | Recovery |
|-------|---------|----------|
| `DriveAuthExpired` | `401` / token expired in memory | Re-consent (`drive.file`); retry the action |
| `DriveScopeMissing` | Backup enabled but scope not yet granted | Incremental authorisation for `drive.file` |
| `BackupNotFound` | Restore requested but no backup file exists | Inform the user; offer to back up first |
| `DriveRateLimited` | `403 userRateLimitExceeded` / `429` | Backoff; surface a retry affordance |
| `DriveServerError` | `5xx` | Exponential backoff; retry on next action |
| `DriveAccessRevoked` | User revoked Drive access in their Google Account | Disable `backup.enabled`; keep all local data; offer re-consent |

> Restore is **destructive** (replace-local) and therefore always gated by an explicit
> user confirmation before `importAll()` runs.

## Examples

### Example 1: Back up now (find-or-create, then upload)

```typescript
await backup.authorize();                       // drive.file consent (opt-in)
const blob = await store.exportAll();           // whole-store JSON (existing primitive)
const existing = await backup.findBackupFile();
const file = existing ?? (await backup.createBackupFile(blob));
if (existing) await backup.updateBackupFile(existing.id, blob);
await setSetting(store, "backup.fileId", file.id);
await setSetting(store, "backup.lastBackupAt", nowMs);
```

### Example 2: Restore (replace-local, after confirmation)

```typescript
await backup.authorize();
const file = await backup.findBackupFile();
if (!file) throw new BackupNotFound();
const blob = await backup.downloadBackupFile(file.id);
await store.importAll(blob);                     // replaces all local data (existing primitive)
```

## Open Questions

- [ ] Should backups be size-bounded or chunked for very large stores, or is a single
      JSON object sufficient for realistic on-device volumes? (Leaning: single object.)
- [ ] Retention: keep only the latest backup (current design), or a small rolling history
      of N versions in Drive?
- [ ] When to prompt a first backup — after the first batch of decisions, or purely
      user-initiated? (Leaning: user-initiated in v1.)

## Migration Notes

New feature; no prior behaviour to migrate. Introduces the new `drive.file` scope
(requested only on opt-in) and the `backup.*` settings keys. No production data exists
(Alpha; see CLAUDE.md "No Backward Compatibility Required").

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-07-18 | Decision 4: document that `importAll` **validates the blob before touching the store** via the shared pure `parseStoreDump` gate — a malformed/corrupt file throws a typed `InvalidBackupError` and leaves data intact (no partial wipe/write), fuzzed at the boundary (#166). | Claude |
| 2026-07-05 | Initial draft: `BackupClient` port, `drive.file` opt-in backup/restore to a single user-visible Drive file, replace-local restore. Home for the backup concern (moved out of the Gmail doc). | Claude |
