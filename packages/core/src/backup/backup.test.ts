// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  backupIfEnabled,
  backupToDrive,
  BACKUP_ENABLED_KEY,
  BACKUP_FILE_ID_KEY,
  BACKUP_LAST_AT_KEY,
  BACKUP_LAST_ERROR_KEY,
  getBackupState,
  restoreFromDrive,
  setBackupEnabled,
} from "./backup";
import { BackupNotFoundError } from "../ports/BackupClient";
import { createInMemoryStore, MockBackupClient, senderBuilder } from "../testing";

const NOW = 1_700_000_000_000;

describe("getBackupState / setBackupEnabled", () => {
  it("defaults to enabled with no markers", async () => {
    const store = createInMemoryStore();
    expect(await getBackupState(store)).toEqual({
      enabled: true,
      lastBackupAt: null,
      lastBackupError: null,
      fileId: null,
    });
  });

  it("persists the master switch", async () => {
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

  it("carries the user's preference in the backup, but not the device-local markers", async () => {
    const store = createInMemoryStore();
    // Opting *out* is the case worth asserting now that on is the default: a restore must
    // reinstate the user's choice, not silently re-enable backup on the new device.
    await setBackupEnabled(store, false);
    const backup = new MockBackupClient();
    // exportAll runs before fileId/lastBackupAt are written, so the first backup's blob
    // captures `enabled` but not those two markers — they are re-established per device.
    await backupToDrive(backup, store, { now: NOW });

    // Simulate a fresh device: wipe everything, then restore.
    await store.wipeAll();
    expect((await getBackupState(store)).enabled).toBe(true); // fresh device: the default

    await restoreFromDrive(backup, store);

    const state = await getBackupState(store);
    expect(state.enabled).toBe(false); // preference travels with the backup
    expect(state.fileId).toBeNull(); // device-local; recovered by name on next backup
    expect(state.lastBackupAt).toBeNull();
  });

  it("throws BackupNotFoundError when no backup exists", async () => {
    const store = createInMemoryStore();
    const backup = new MockBackupClient();
    await expect(restoreFromDrive(backup, store)).rejects.toBeInstanceOf(BackupNotFoundError);
  });

  it("propagates a write failure to the caller of the manual backup", async () => {
    const store = createInMemoryStore();
    const backup = new MockBackupClient();
    backup.writeError = new Error("drive unavailable");
    await expect(backupToDrive(backup, store, { now: NOW })).rejects.toThrow("drive unavailable");
  });
});

describe("backupIfEnabled", () => {
  it("backs up and clears any recorded error when enabled", async () => {
    const store = createInMemoryStore();
    await store.settings.put({ key: BACKUP_LAST_ERROR_KEY, value: "an earlier failure" });
    const backup = new MockBackupClient();

    const result = await backupIfEnabled(backup, store, { now: NOW });

    expect(result?.created).toBe(true);
    const state = await getBackupState(store);
    expect(state.lastBackupAt).toBe(NOW);
    expect(state.lastBackupError).toBeNull();
  });

  it("is a no-op when the user has turned backup off", async () => {
    const store = createInMemoryStore();
    await setBackupEnabled(store, false);
    const backup = new MockBackupClient();

    expect(await backupIfEnabled(backup, store, { now: NOW })).toBeNull();
    expect(backup.currentData()).toBeUndefined();
  });

  it("records a failure instead of throwing — an unasked-for write must not interrupt", async () => {
    const store = createInMemoryStore();
    const backup = new MockBackupClient();
    backup.writeError = new Error("drive unavailable");

    expect(await backupIfEnabled(backup, store, { now: NOW })).toBeNull();
    const state = await getBackupState(store);
    expect(state.lastBackupError).toBe("drive unavailable");
    expect(state.lastBackupAt).toBeNull();
  });
});

describe("default state", () => {
  it("is enabled on a fresh store — backup is opt-out (design-backup-restore.md D2)", async () => {
    expect((await getBackupState(createInMemoryStore())).enabled).toBe(true);
  });
});

describe("settings keys", () => {
  it("exposes the backup.* setting keys used by the store", () => {
    expect(BACKUP_ENABLED_KEY).toBe("backup.enabled");
    expect(BACKUP_LAST_AT_KEY).toBe("backup.lastBackupAt");
    expect(BACKUP_FILE_ID_KEY).toBe("backup.fileId");
  });
});
