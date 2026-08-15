// SPDX-License-Identifier: Apache-2.0
import { getBackupState, setBackupEnabled } from "@inboxclinic/core";
import { createInMemoryStore, MockBackupClient, senderBuilder } from "@inboxclinic/core/testing";
import type { Store } from "@inboxclinic/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelPendingBackup, initAutoBackup, resetAutoBackup, scheduleBackup } from "./autoBackup";

const DEBOUNCE_MS = 30_000;

/** Advance past the debounce window and let the queued backup's promises settle. */
async function runDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
}

async function seeded(): Promise<Store> {
  const store = createInMemoryStore();
  await store.senders.put(senderBuilder("a@x.com"));
  return store;
}

describe("autoBackup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetAutoBackup();
    vi.useRealTimers();
  });

  it("backs up once the user stops deciding", async () => {
    const store = await seeded();
    const backup = new MockBackupClient();
    initAutoBackup(backup, store);

    scheduleBackup();
    expect(backup.currentData()).toBeUndefined(); // nothing yet — still in the quiet period

    await runDebounce();

    expect(backup.currentData()).toBeDefined();
  });

  it("collapses a burst of decisions into a single upload", async () => {
    const store = await seeded();
    const backup = new MockBackupClient();
    initAutoBackup(backup, store);

    // A triage run: each decision restarts the window, so only the last one counts.
    for (let i = 0; i < 40; i += 1) {
      scheduleBackup();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(backup.currentData()).toBeUndefined();

    await runDebounce();

    expect(backup.currentData()).toBeDefined();
    expect((await getBackupState(store)).lastBackupAt).not.toBeNull();
  });

  it("writes nothing when the user has turned backup off", async () => {
    const store = await seeded();
    await setBackupEnabled(store, false);
    const backup = new MockBackupClient();
    initAutoBackup(backup, store);

    scheduleBackup();
    await runDebounce();

    expect(backup.currentData()).toBeUndefined();
  });

  it("records a failure quietly rather than throwing at the user", async () => {
    const store = await seeded();
    const backup = new MockBackupClient();
    backup.writeError = new Error("drive unavailable");
    initAutoBackup(backup, store);

    scheduleBackup();
    await runDebounce();

    expect((await getBackupState(store)).lastBackupError).toBe("drive unavailable");
  });

  // The whole point of the grant check: a timer must never be the reason a consent
  // dialog appears (architecture.md §6).
  it("skips the upload entirely when no grant is held", async () => {
    const store = await seeded();
    const backup = new MockBackupClient();
    initAutoBackup(backup, store, () => false);

    scheduleBackup();
    await runDebounce();

    expect(backup.currentData()).toBeUndefined();
    expect((await getBackupState(store)).lastBackupError).toBeNull(); // not a failure
  });

  it("cancels a queued upload on sign-out, so it cannot outlive the session", async () => {
    const store = await seeded();
    const backup = new MockBackupClient();
    initAutoBackup(backup, store);

    scheduleBackup();
    cancelPendingBackup();
    await runDebounce();

    expect(backup.currentData()).toBeUndefined();
  });

  it("does nothing before the app has wired a store — no backup of an empty session", async () => {
    scheduleBackup();
    await runDebounce();
    // Reaching here without throwing is the assertion: an unwired schedule is a no-op.
    expect(vi.getTimerCount()).toBe(0);
  });
});
