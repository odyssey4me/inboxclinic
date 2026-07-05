// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  backupToDrive,
  BACKUP_ENABLED_KEY,
  BACKUP_FILE_ID_KEY,
  BACKUP_LAST_AT_KEY,
  getBackupState,
  restoreFromDrive,
  setBackupEnabled,
} from "./backup";
import { BackupNotFoundError } from "../ports/BackupClient";
import { senderBuilder } from "../testing/builders";
import { createInMemoryStore } from "../testing/inMemoryStore";
import { MockBackupClient } from "../testing/MockBackupClient";

const NOW = 1_700_000_000_000;

describe("getBackupState / setBackupEnabled", () => {
  it("defaults to disabled with no markers", async () => {
    const store = createInMemoryStore();
    expect(await getBackupState(store)).toEqual({
      enabled: false,
      lastBackupAt: null,
      fileId: null,
    });
  });

  it("persists the opt-in flag", async () => {
    const store = createInMemoryStore();
    await setBackupEnabled(store, true);
    expect((await getBackupState(store)).enabled).toBe(true);
    await setBackupEnabled(store, false);
    expect((await getBackupState(store)).enabled).toBe(false);
  });
});

describe("backupToDrive", () => {
  it("creates the backup file when none exists and records the markers", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("a@x.com"));
    const backup = new MockBackupClient();

    const result = await backupToDrive(backup, store, { now: NOW });

    expect(result.created).toBe(true);
    expect(backup.authorized).toBe(true);
    expect(backup.currentData()).toBeDefined();
    const state = await getBackupState(store);
    expect(state.fileId).toBe(result.fileId);
    expect(state.lastBackupAt).toBe(NOW);
  });

  it("overwrites the existing file in place on a second backup (same file id)", async () => {
    const store = createInMemoryStore();
    const backup = new MockBackupClient();

    const first = await backupToDrive(backup, store, { now: NOW });
    const second = await backupToDrive(backup, store, { now: NOW + 1000 });

    expect(second.created).toBe(false);
    expect(second.fileId).toBe(first.fileId);
    expect((await getBackupState(store)).lastBackupAt).toBe(NOW + 1000);
  });

  it("defaults lastBackupAt to a real clock when now is omitted", async () => {
    const store = createInMemoryStore();
    const backup = new MockBackupClient();
    const before = Date.now();

    const result = await backupToDrive(backup, store);

    expect(result.backedUpAt).toBeGreaterThanOrEqual(before);
  });
});

describe("restoreFromDrive", () => {
  it("round-trips the store: backup → mutate → restore reverts local data", async () => {
    const store = createInMemoryStore();
    await store.senders.put(senderBuilder("keep@x.com", { trustStatus: "trusted" }));
    const backup = new MockBackupClient();

    await backupToDrive(backup, store, { now: NOW });

    // Mutate after the backup: change the existing sender and add a new one.
    await store.senders.put(senderBuilder("keep@x.com", { trustStatus: "blocked" }));
    await store.senders.put(senderBuilder("added@y.com"));

    const result = await restoreFromDrive(backup, store);

    const senders = await store.senders.query({});
    expect(senders).toHaveLength(1);
    expect(senders[0]?.email).toBe("keep@x.com");
    expect(senders[0]?.trustStatus).toBe("trusted");
    expect(result.fileId).toBeDefined();
    expect(result.restoredFrom).not.toBe("");
  });

  it("carries the opt-in preference in the backup, but not the device-local markers", async () => {
    const store = createInMemoryStore();
    await setBackupEnabled(store, true);
    const backup = new MockBackupClient();
    // exportAll runs before fileId/lastBackupAt are written, so the first backup's blob
    // captures `enabled` but not those two markers — they are re-established per device.
    await backupToDrive(backup, store, { now: NOW });

    // Simulate a fresh device: wipe everything, then restore.
    await store.wipeAll();
    expect((await getBackupState(store)).enabled).toBe(false);

    await restoreFromDrive(backup, store);

    const state = await getBackupState(store);
    expect(state.enabled).toBe(true); // preference travels with the backup
    expect(state.fileId).toBeNull(); // device-local; recovered by name on next backup
    expect(state.lastBackupAt).toBeNull();
  });

  it("throws BackupNotFoundError when no backup exists", async () => {
    const store = createInMemoryStore();
    const backup = new MockBackupClient();
    await expect(restoreFromDrive(backup, store)).rejects.toBeInstanceOf(BackupNotFoundError);
  });

  it("propagates a declined drive.file consent", async () => {
    const store = createInMemoryStore();
    const backup = new MockBackupClient();
    backup.authorizeError = new Error("consent declined");
    await expect(backupToDrive(backup, store, { now: NOW })).rejects.toThrow("consent declined");
  });
});

describe("settings keys", () => {
  it("exposes the backup.* setting keys used by the store", () => {
    expect(BACKUP_ENABLED_KEY).toBe("backup.enabled");
    expect(BACKUP_LAST_AT_KEY).toBe("backup.lastBackupAt");
    expect(BACKUP_FILE_ID_KEY).toBe("backup.fileId");
  });
});
