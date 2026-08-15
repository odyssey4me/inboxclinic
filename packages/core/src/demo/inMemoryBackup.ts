// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory, fixture-backed `BackupClient`.
 *
 * A complete `BackupClient` port with no transport: it models the single-file backup
 * with real in-memory state, so `backupToDrive` / `restoreFromDrive` exercise the
 * genuine find-or-create, overwrite, and download paths. It backs both **demo mode**
 * (`@inboxclinic/core/demo`, shippable) and the **tests** (`@inboxclinic/core/testing`
 * re-exports it as `MockBackupClient`). `modifiedTime` is a deterministic counter
 * (RFC-3339-shaped) so no wall clock is needed.
 */

import type { BackupClient, BackupFile } from "../ports/BackupClient";
import { BackupNotFoundError } from "../ports/BackupClient";

const FIXED_FILE_ID = "backup-file";

export class InMemoryBackupClient implements BackupClient {
  private file: { meta: BackupFile; data: Uint8Array } | undefined;
  private writeSeq = 0;
  /**
   * When set, every write rejects with it — the `DriveScopeMissing` / transport-failure
   * path an automatic backup has to swallow (design-backup-restore.md Decision 4).
   */
  writeError: Error | undefined;
  /** Records the file ids passed to `downloadBackupFile`, for assertions. */
  readonly downloads: string[] = [];

  /** Optionally seed an existing backup (e.g. to test the update + restore paths). */
  constructor(seed?: Uint8Array) {
    if (seed !== undefined) {
      this.file = { meta: this.nextMeta(), data: new Uint8Array(seed) };
    }
  }

  /** Fresh metadata with a monotonically increasing (deterministic) modifiedTime. */
  private nextMeta(): BackupFile {
    this.writeSeq += 1;
    return {
      id: FIXED_FILE_ID,
      name: "Inbox Clinic Backup.json",
      modifiedTime: new Date(this.writeSeq * 1000).toISOString(),
    };
  }

  findBackupFile(): Promise<BackupFile | undefined> {
    return Promise.resolve(this.file !== undefined ? { ...this.file.meta } : undefined);
  }

  createBackupFile(blob: Uint8Array): Promise<BackupFile> {
    if (this.writeError !== undefined) return Promise.reject(this.writeError);
    const meta = this.nextMeta();
    this.file = { meta, data: new Uint8Array(blob) };
    return Promise.resolve({ ...meta });
  }

  updateBackupFile(id: string, blob: Uint8Array): Promise<void> {
    if (this.writeError !== undefined) return Promise.reject(this.writeError);
    if (this.file === undefined || this.file.meta.id !== id) {
      return Promise.reject(new BackupNotFoundError(`InMemoryBackupClient: no file with id ${id}`));
    }
    this.file = { meta: this.nextMeta(), data: new Uint8Array(blob) };
    return Promise.resolve();
  }

  downloadBackupFile(id: string): Promise<Uint8Array> {
    this.downloads.push(id);
    if (this.file === undefined || this.file.meta.id !== id) {
      return Promise.reject(new BackupNotFoundError(`InMemoryBackupClient: no file with id ${id}`));
    }
    return Promise.resolve(new Uint8Array(this.file.data));
  }

  /** The currently stored backup bytes, or `undefined` if none. */
  currentData(): Uint8Array | undefined {
    return this.file !== undefined ? new Uint8Array(this.file.data) : undefined;
  }
}
