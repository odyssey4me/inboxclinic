// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory, fixture-backed `BackupClient` for tests.
 *
 * See docs/design-testing.md (mock Google at the port) and docs/design-backup-restore.md.
 * Nothing reaches the network: it models the single-file backup with real in-memory
 * state, so `backupToDrive` / `restoreFromDrive` exercise the genuine find-or-create,
 * overwrite, and download paths. `authorize` and download calls are recorded for
 * assertions. `modifiedTime` is a deterministic counter (RFC-3339-shaped) so tests need
 * no wall clock.
 */

import type { BackupClient, BackupFile } from "../ports/BackupClient";
import { BackupNotFoundError } from "../ports/BackupClient";

const FIXED_FILE_ID = "backup-file";

export class MockBackupClient implements BackupClient {
  private file: { meta: BackupFile; data: Uint8Array } | undefined;
  private writeSeq = 0;
  /** True once `authorize()` has succeeded — for consent/opt-in assertions. */
  authorized = false;
  /** When set, `authorize()` rejects with it (simulate declined `drive.file` consent). */
  authorizeError: Error | undefined;
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

  authorize(): Promise<void> {
    if (this.authorizeError !== undefined) return Promise.reject(this.authorizeError);
    this.authorized = true;
    return Promise.resolve();
  }

  findBackupFile(): Promise<BackupFile | undefined> {
    return Promise.resolve(this.file !== undefined ? { ...this.file.meta } : undefined);
  }

  createBackupFile(blob: Uint8Array): Promise<BackupFile> {
    const meta = this.nextMeta();
    this.file = { meta, data: new Uint8Array(blob) };
    return Promise.resolve({ ...meta });
  }

  updateBackupFile(id: string, blob: Uint8Array): Promise<void> {
    if (this.file === undefined || this.file.meta.id !== id) {
      return Promise.reject(new BackupNotFoundError(`MockBackupClient: no file with id ${id}`));
    }
    this.file = { meta: this.nextMeta(), data: new Uint8Array(blob) };
    return Promise.resolve();
  }

  downloadBackupFile(id: string): Promise<Uint8Array> {
    this.downloads.push(id);
    if (this.file === undefined || this.file.meta.id !== id) {
      return Promise.reject(new BackupNotFoundError(`MockBackupClient: no file with id ${id}`));
    }
    return Promise.resolve(new Uint8Array(this.file.data));
  }

  /** Test helper: the currently stored backup bytes, or `undefined` if none. */
  currentData(): Uint8Array | undefined {
    return this.file !== undefined ? new Uint8Array(this.file.data) : undefined;
  }
}
