// SPDX-License-Identifier: Apache-2.0
/**
 * Backup / restore orchestration (pure over the `BackupClient` and `Store` ports).
 *
 * See docs/design-backup-restore.md. `backupToDrive` copies the whole on-device store to
 * the user's own Drive (a single file, overwritten in place); `restoreFromDrive` pulls it
 * back, **replacing** all local data. The on-device store is the source of truth — a
 * failed backup never mutates it. Backup state lives in the `settings` store under the
 * `backup.*` keys (design-backup-restore.md Configuration). No transport specifics leak
 * in here: `exportAll`/`importAll` handle serialisation, the port handles Drive.
 *
 * There is no consent step: `drive.file` is part of the sign-in grant, so backup is
 * **on by default** and `backupIfEnabled` can run unattended after a decision batch.
 */

import type { BackupClient } from "../ports/BackupClient";
import { BackupNotFoundError } from "../ports/BackupClient";
import type { Repo, Setting, Store } from "../store";

/**
 * Master switch. **Opt-out, default on** (design-backup-restore.md Decision 2): the
 * `drive.file` scope arrives with the sign-in grant, so enabling costs no consent step.
 */
export const BACKUP_ENABLED_KEY = "backup.enabled";
/** Epoch ms of the last successful backup. */
export const BACKUP_LAST_AT_KEY = "backup.lastBackupAt";
/** Message from the most recent failed automatic backup; cleared on success. */
export const BACKUP_LAST_ERROR_KEY = "backup.lastBackupError";
/** Cached Drive id of the backup file (recoverable by name if stale/absent). */
export const BACKUP_FILE_ID_KEY = "backup.fileId";

/** Backup is on unless the user has turned it off (design-backup-restore.md Decision 2). */
export const BACKUP_ENABLED_DEFAULT = true;

/** The on-device backup state, read from the `settings` store. */
export interface BackupState {
  enabled: boolean;
  lastBackupAt: number | null;
  lastBackupError: string | null;
  fileId: string | null;
}

/** Outcome of {@link backupToDrive}. */
export interface BackupResult {
  fileId: string;
  backedUpAt: number;
  /** `true` if the backup file was created this run; `false` if an existing one was overwritten. */
  created: boolean;
}

/** Outcome of {@link restoreFromDrive}. */
export interface RestoreResult {
  fileId: string;
  /** The `modifiedTime` of the restored backup file, for surfacing "restored from …". */
  restoredFrom: string;
}

/** Options shared by the orchestration entry points. */
export interface BackupOptions {
  /** Injected clock for the `lastBackupAt` marker (defaults to `Date.now()`). */
  now?: number;
}

async function readSetting<T>(settings: Repo<Setting>, key: string): Promise<T | undefined> {
  const record = await settings.get(key);
  return record?.value as T | undefined;
}

async function writeSetting(settings: Repo<Setting>, key: string, value: unknown): Promise<void> {
  await settings.put({ key, value });
}

/** Read the master switch, last-backup markers, and cached file id from the store. */
export async function getBackupState(store: Store): Promise<BackupState> {
  return {
    enabled:
      (await readSetting<boolean>(store.settings, BACKUP_ENABLED_KEY)) ?? BACKUP_ENABLED_DEFAULT,
    lastBackupAt: (await readSetting<number>(store.settings, BACKUP_LAST_AT_KEY)) ?? null,
    lastBackupError: (await readSetting<string>(store.settings, BACKUP_LAST_ERROR_KEY)) ?? null,
    fileId: (await readSetting<string>(store.settings, BACKUP_FILE_ID_KEY)) ?? null,
  };
}

/**
 * Persist the master switch. Turning it off stops future uploads; it does **not**
 * delete the existing Drive file, which is the user's to keep or remove.
 */
export async function setBackupEnabled(store: Store, enabled: boolean): Promise<void> {
  await writeSetting(store.settings, BACKUP_ENABLED_KEY, enabled);
}

/**
 * Back up the whole on-device store to the user's Drive: `exportAll` → find-or-create the
 * single backup file → overwrite in place → record `fileId` + `lastBackupAt`. Best-effort
 * and idempotent (re-running overwrites the same file); the local store is never mutated.
 */
export async function backupToDrive(
  backup: BackupClient,
  store: Store,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const now = options.now ?? Date.now();
  const blob = await store.exportAll();
  const existing = await backup.findBackupFile();

  let fileId: string;
  let created: boolean;
  if (existing !== undefined) {
    await backup.updateBackupFile(existing.id, blob);
    fileId = existing.id;
    created = false;
  } else {
    const file = await backup.createBackupFile(blob);
    fileId = file.id;
    created = true;
  }

  await writeSetting(store.settings, BACKUP_FILE_ID_KEY, fileId);
  await writeSetting(store.settings, BACKUP_LAST_AT_KEY, now);
  await writeSetting(store.settings, BACKUP_LAST_ERROR_KEY, null);
  return { fileId, backedUpAt: now, created };
}

/**
 * Run {@link backupToDrive} for an **automatic** backup: a no-op when the user has
 * turned backup off, and never throwing. A background write the user did not ask for
 * must not interrupt them, so a failure is recorded in `backup.lastBackupError` for
 * Settings to surface quietly and retried on the next commit
 * (design-backup-restore.md Decision 4).
 */
export async function backupIfEnabled(
  backup: BackupClient,
  store: Store,
  options: BackupOptions = {},
): Promise<BackupResult | null> {
  const { enabled } = await getBackupState(store);
  if (!enabled) return null;
  try {
    return await backupToDrive(backup, store, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSetting(store.settings, BACKUP_LAST_ERROR_KEY, message);
    return null;
  }
}

/**
 * Restore the on-device store from the Drive backup: find → download → `importAll`. This
 * **replaces all local data** (design-backup-restore.md Decision 4), so the caller must
 * confirm the destructive warning first. Throws {@link BackupNotFoundError} when no backup
 * exists yet.
 */
export async function restoreFromDrive(backup: BackupClient, store: Store): Promise<RestoreResult> {
  const file = await backup.findBackupFile();
  if (file === undefined) {
    throw new BackupNotFoundError();
  }
  const blob = await backup.downloadBackupFile(file.id);
  await store.importAll(blob);
  return { fileId: file.id, restoredFrom: file.modifiedTime };
}
