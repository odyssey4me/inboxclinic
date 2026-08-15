# Design: Backup & Restore (Google Drive)

> **Status:** Draft (Alpha)
>
> **Last Updated:** 2026-08-15

## Overview

Inbox Clinic stores **all** user data on-device in IndexedDB (see
[design-local-store-schema.md](design-local-store-schema.md)). Most of that data is
reconstructible by re-scanning the inbox — but **user decisions are not**, so
architecture.md §5 makes **backup a first-class capability**, **on by default**. This
document owns the **backup/restore feature**: how the on-device store is copied to, and
recovered from, the **user's own Google Drive**.

It is a **separate concern from Gmail integration** — a different Google API behind its
own port — so it lives in its own doc rather than in
[design-gmail-integration.md](design-gmail-integration.md). It establishes:

- The `BackupClient` **port** (in `packages/core`) and its browser Drive adapter.
- The least-permission **`drive.file`** scope, granted with everything else at sign-in
  ([design-gmail-integration.md](design-gmail-integration.md) Decision 2).
- A single, user-visible backup file and its find-or-create/update semantics.
- **Automatic, best-effort backup after decisions**, plus a manual action.
- **Restore = replace-local, not sync.**

It reuses the store's existing `exportAll()` / `importAll()` primitives
([design-local-store-schema.md](design-local-store-schema.md)) — this feature adds the
**transport**, not the serialisation.

## Architecture Reference

This design implements the following sections of [architecture.md](architecture.md):

| Section | Title | Relevance |
|---------|-------|-----------|
| 5 | Data & Privacy Boundaries | Backup is first-class and its own egress row: user-owned data goes to the user's *own* Drive, same account, one visible file; still no service-side custody |
| 6 | Core Interfaces | Realises the Store's `export`/`import` via a new provider port (`BackupClient`); `drive.file` is part of the single sign-in grant |
| 8 | User Settings & Opt-in Features | Backup is **opt-out, default on** — it needs no permission beyond the sign-in grant and sends data nowhere but the user's own account |

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
- Fold the Drive methods into `GmailClient` — rejected; mixes two Google APIs behind a
  Gmail-named port. The two adapters still share **one** token grant (Decision 2); a
  shared grant does not imply a shared port.
- Generic "cloud storage" abstraction over several providers — rejected as premature;
  Drive is the only v1 target (YAGNI).

### Decision 2: Least-permission `drive.file`, granted at sign-in, backup on by default

**Context:** Drive access is sensitive. The user must trust that the app cannot read the
rest of their Drive. Separately, decision history is the one thing a re-scan **cannot**
rebuild (architecture.md §5) — so a backup the user has to remember to switch on protects
exactly the people least likely to switch it on.

**Decision:** Request only **`drive.file`** — which grants access **only to files the app
itself creates or opens** — as part of the **single sign-in grant**
([design-gmail-integration.md](design-gmail-integration.md) Decision 2). There is no
separate Drive consent step. Backup is **on by default** (`backup.enabled: true`) and the
user can turn it off at any time in Settings.

| Scope | Grants | Requested |
|-------|--------|-----------|
| `drive.file` | Read/write **only** app-created files | At sign-in, with the Gmail scopes |

**Rationale:** `drive.file` is the minimum that supports a user-visible backup file and
**cannot** enumerate or read the user's other Drive content — honouring data
minimisation (architecture.md §5). Default-on is permitted by architecture.md §8 because
the capability needs no permission beyond the sign-in grant and sends data nowhere but
the user's own account; §5 records it as an egress class in its own right. The hosted
instance runs in testing mode with a ≤100-user allowlist, so no verification is required
(architecture.md §7).

**Alternatives considered:**
- `drive.appdata` (hidden app-data folder) — rejected; the backup would be invisible to
  the user, weakening the "user owns their data" posture. A visible file is intentional.
  Default-on makes visibility more important, not less: the user must be able to find and
  delete what the app wrote.
- Full `drive` scope — rejected; grossly over-permissioned.
- Keeping backup opt-in now that consent is free — rejected; the consent prompt was never
  the reason for default-off, and the durability argument in §5 applies to every user.

### Decision 3: A single, user-visible backup file, updated in place

**Decision:** Maintain **one** file named **`Inbox Clinic Backup.json`** in the user's
Drive. Back-up is **find-or-create by name, then overwrite**: if a prior backup exists
(matched by the stored `fileId`, else by name), **update** it in place; otherwise
**create** it. The stored `fileId` is cached in the `settings` store.

**Rationale:** One visible, in-place file is transparent (the user can see and manage it)
and avoids Drive clutter. `drive.file` keeps app-created files user-visible while denying
access to everything else.

### Decision 4: Automatic backup after decisions; restore is replace-local, not sync

**Context:** True multi-device sync is out of scope (design-local-store-schema.md);
backup exists for durability and device migration. Since backup is now **on by default**
(Decision 2), a switch that never writes anything on its own would be a false assurance —
the data at risk is exactly the data the user has just created.

**Decision:** While `backup.enabled` is true, the app backs up **automatically and
best-effort** after a batch of decisions is committed, **debounced** by
`backup.debounceMs` so a rapid run of decisions produces one upload rather than dozens.
The manual **"Back up now"** action remains, for an immediate write before switching
device. Nothing is uploaded before the user's first decision — an empty store is not
worth a file.

**Restore is always manual and explicit**: a "Restore from backup" action that **replaces
all local data** via `Store.importAll()` after a destructive-action confirmation. There is
**no merge and no continuous sync**, and restore never happens automatically — an
auto-restore could silently overwrite newer local decisions.

A failed automatic backup is **not** a modal error: it surfaces as a quiet status in
Settings (last-backup time plus the failure) and retries on the next commit. Only the
manual action reports failure directly to the user, because only the manual action was
asked for.

**The automatic path never prompts.** It runs off a timer, so before uploading it checks
that a grant is already held and skips otherwise — a background task must not be the
reason a consent screen appears
([design-gmail-integration.md](design-gmail-integration.md) Decision 1). Sign-out
cancels any queued upload for the same reason: a write must not outlive the session that
scheduled it.

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
```

`DRIVE_FILE_SCOPE` is **not** declared here: it lives with the rest of the sign-in grant
in `packages/core/src/ports/scopes.ts`, because the scope set has to be assembled in one
place to stay a single prompt ([design-gmail-integration.md](design-gmail-integration.md)
Decision 2).

There is **no `authorize()` method**. `drive.file` arrives with the sign-in grant, so the
Drive adapter takes its token from the same in-memory grant as the Gmail adapter rather
than running a consent flow of its own — one grant, one token, two adapters.

| Method | Drive endpoint | Notes |
|--------|----------------|-------|
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
| `backup.enabled` | boolean | `true` | Master switch (opt-out). Needs no consent step — `drive.file` is already granted (Decision 2) |
| `backup.debounceMs` | number | `30000` | Quiet period after a decision batch before an automatic backup runs (Decision 4) |
| `backup.lastBackupAt` | number \| null | `null` | Epoch ms of the last successful backup |
| `backup.lastBackupError` | string \| null | `null` | Message from the most recent failed automatic backup; cleared on success (Decision 4) |
| `backup.fileId` | string \| null | `null` | Cached Drive id of `Inbox Clinic Backup.json` |

Turning `backup.enabled` off stops future uploads; it does **not** delete the existing
Drive file, which is the user's to keep or remove.

## Error Handling

Errors surface to the UI; the client maps Drive HTTP failures to typed errors and
recovers locally. The local store is never mutated by a failed backup.

| Error | Trigger | Recovery |
|-------|---------|----------|
| `DriveAuthExpired` | `401` / token expired in memory | Re-authenticate with the **full sign-in scope set**; retry the action |
| `DriveScopeMissing` | `403` — `drive.file` absent from the grant (the user unticked it on the consent screen) | Record `backup.lastBackupError`, stop automatic attempts, and offer re-authentication that explains backup is unavailable without it. Never a narrower re-ask |
| `BackupNotFound` | Restore requested but no backup file exists | Inform the user; offer to back up first |
| `DriveRateLimited` | `403 userRateLimitExceeded` / `429` | Backoff; surface a retry affordance |
| `DriveServerError` | `5xx` | Exponential backoff; retry on next action |
| `DriveAccessRevoked` | User revoked access in their Google Account | Keep all local data and leave `backup.enabled` as the user set it; the whole grant is gone, so recovery is the ordinary sign-in path |

> Restore is **destructive** (replace-local) and therefore always gated by an explicit
> user confirmation before `importAll()` runs.

## Examples

### Example 1: Back up now (find-or-create, then upload)

```typescript
// No authorize() step: drive.file came with the sign-in grant (Decision 2).
const blob = await store.exportAll();           // whole-store JSON (existing primitive)
const existing = await backup.findBackupFile();
const file = existing ?? (await backup.createBackupFile(blob));
if (existing) await backup.updateBackupFile(existing.id, blob);
await setSetting(store, "backup.fileId", file.id);
await setSetting(store, "backup.lastBackupAt", nowMs);
```

### Example 2: Restore (replace-local, after confirmation)

```typescript
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
- [ ] Should `backup.debounceMs` (30s) also carry a floor on *upload frequency*, so a long
      decision session cannot produce a write every 30 seconds against Drive's quota? The
      trigger and the constant are a first guess to be revisited against real usage — see
      issue #246.
- [ ] **Client-side encryption of the backup blob.** Transit is HTTPS and Drive encrypts at
      rest, but the file is plaintext to Google and to anyone with access to the account —
      and it contains the user's full decision history and sender graph. Encrypting the blob
      under a user-held key (and what to do when that key is lost, given restore is the
      disaster-recovery path) is unresolved — see issue #245.

## Migration Notes

New feature; no prior behaviour to migrate. `drive.file` is part of the sign-in grant and
the `backup.*` settings keys are new. `backup.enabled` now defaults to **`true`**, and
`BackupClient.authorize()` is **removed** — both are breaking changes against the earlier
draft, which is permitted here: no production data exists (Alpha; see CLAUDE.md "No
Backward Compatibility Required").

---

**Changelog:**

| Date | Change | Author |
|------|--------|--------|
| 2026-08-15 | **Backup is default-on, and `drive.file` moves into the sign-in grant.** Decision 2: no separate Drive consent step — the scope arrives with the Gmail scopes (design-gmail-integration.md Decision 2), so the only thing default-off was ever buying was one fewer prompt. `backup.enabled` now defaults to `true`, permitted by architecture.md v3.3 §8 because backup needs no extra permission and writes only to the user's own account (recorded as its own §5 egress row). Decision 4: with the switch on by default it must actually do something, so backup runs **automatically and best-effort after a decision batch**, debounced by the new `backup.debounceMs` (30s), with "Back up now" retained and restore still manual and confirmation-gated; automatic failures are recorded in the new `backup.lastBackupError` rather than shown as modal errors. `BackupClient.authorize()` is removed — one grant, one token, two adapters. Added an open question on client-side encryption of the backup blob. | Claude |
| 2026-07-18 | Decision 4: document that `importAll` **validates the blob before touching the store** via the shared pure `parseStoreDump` gate — a malformed/corrupt file throws a typed `InvalidBackupError` and leaves data intact (no partial wipe/write), fuzzed at the boundary (#166). | Claude |
| 2026-07-05 | Initial draft: `BackupClient` port, `drive.file` opt-in backup/restore to a single user-visible Drive file, replace-local restore. Home for the backup concern (moved out of the Gmail doc). | Claude |
