// SPDX-License-Identifier: Apache-2.0
/**
 * `BackupClient` port — the opt-in backup transport for Inbox Clinic.
 *
 * See docs/design-backup-restore.md ("BackupClient port") and architecture.md §5
 * (backup is a first-class, user-owned capability) / §6 (realises the Store's
 * export/import over provider access). The port is framework-agnostic: the backup
 * orchestration depends on this interface, not on any transport. A browser Drive-REST
 * adapter lives in `apps/web`; a `MockBackupClient` (in `../testing`) backs the tests.
 *
 * The port carries **opaque blobs** — it neither serialises nor interprets store
 * contents (that is `Store.exportAll` / `importAll`). Today it targets a single,
 * user-visible file in the user's own Google Drive, found-or-created then overwritten
 * in place (design-backup-restore.md Decisions 3 & 4).
 */

/** Identity + metadata for the single backup file. */
export interface BackupFile {
  /** Provider file id (e.g. the Drive file id). */
  id: string;
  /** Always {@link BACKUP_FILE_NAME}. */
  name: string;
  /** RFC 3339 timestamp of the last modification, as reported by the provider. */
  modifiedTime: string;
}

/** The fixed, user-visible backup file name in the user's own Drive (Decision 3). */
export const BACKUP_FILE_NAME = "Inbox Clinic Backup.json";

/**
 * Least-permission Drive scope: read/write **only** files the app itself creates or
 * opens — it cannot enumerate or read the rest of the user's Drive (Decision 2).
 */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * Thrown when a restore is requested but no backup file exists yet (design-backup
 * -restore.md `BackupNotFound`). Carried as a typed error so the recovery branch —
 * "offer to back up first" — stays explicit rather than string-matching a failure.
 */
export class BackupNotFoundError extends Error {
  constructor(message = "No Inbox Clinic backup exists in Drive yet") {
    super(message);
    this.name = "BackupNotFoundError";
  }
}

/**
 * The backup-transport port. Implementations are adapters (browser fetch + GIS in
 * `apps/web`; an in-memory fixture mock in `../testing`).
 */
export interface BackupClient {
  /** Ensure a valid `drive.file` token, prompting incremental consent on first use. */
  authorize(): Promise<void>;
  /** Locate the existing backup file by name; `undefined` if none exists yet. */
  findBackupFile(): Promise<BackupFile | undefined>;
  /** Create the backup file with the given bytes; resolves to its identity. */
  createBackupFile(blob: Uint8Array): Promise<BackupFile>;
  /** Overwrite an existing backup file's contents in place (media update). */
  updateBackupFile(id: string, blob: Uint8Array): Promise<void>;
  /** Download a backup file's raw bytes (for restore). */
  downloadBackupFile(id: string): Promise<Uint8Array>;
}
