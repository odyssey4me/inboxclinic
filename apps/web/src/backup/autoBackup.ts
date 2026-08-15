// SPDX-License-Identifier: Apache-2.0
/**
 * Debounced automatic backup after decisions.
 *
 * See docs/design-backup-restore.md Decision 4. Backup is on by default, so it has to
 * actually run without being asked: every place that commits a decision calls
 * {@link scheduleBackup}, and a single upload follows once the user stops for
 * `DEBOUNCE_MS`. A triage run of forty decisions therefore produces one write, not forty.
 *
 * The wiring is a module singleton (initialised once in `main.tsx`) rather than props
 * threaded through four component trees, matching how `reporting/recentErrors` is
 * reached from anywhere. Failures are swallowed by `backupIfEnabled` and surfaced in
 * Settings — a write the user did not ask for must not interrupt them.
 *
 * Nothing is scheduled before the first decision: an empty store is not worth a file.
 */

import { backupIfEnabled } from "@inboxclinic/core";
import type { BackupClient, Store } from "@inboxclinic/core";

/** Quiet period after the last decision before the upload runs (`backup.debounceMs`). */
const DEBOUNCE_MS = 30_000;

interface AutoBackupTarget {
  backup: BackupClient;
  store: Store;
  /** Whether a grant is already held, so the upload cannot raise a consent prompt. */
  hasLiveGrant: () => boolean;
}

let target: AutoBackupTarget | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Wire the scheduler to the app's backup client and store. Call once, at bootstrap.
 *
 * `hasLiveGrant` is what keeps this path from becoming a consent trigger: a timer
 * firing with no token would otherwise send the user a sign-in dialog they did nothing
 * to ask for. Demo mode has no real grant and passes nothing.
 */
export function initAutoBackup(
  backup: BackupClient,
  store: Store,
  hasLiveGrant: () => boolean = () => true,
): void {
  target = { backup, store, hasLiveGrant };
}

/**
 * Note that decisions changed. Restarts the debounce window, so a burst of decisions
 * collapses into one upload after the user stops.
 */
export function scheduleBackup(): void {
  if (target === null) return;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, DEBOUNCE_MS);
}

async function run(): Promise<void> {
  if (target === null) return;
  // No grant means the user is signed out, was never signed in, or declined — in every
  // case this is not the moment to ask. Skip; the next decision reschedules.
  if (!target.hasLiveGrant()) return;
  // Offline is an expected, uninteresting failure — leave the last recorded state alone
  // and wait for the next decision rather than writing "Failed to fetch" into Settings.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  await backupIfEnabled(target.backup, target.store);
}

/** Cancel any pending upload — used on sign-out, so a queued write cannot outlive it. */
export function cancelPendingBackup(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/** Test seam: drop any pending timer and unwire the scheduler. */
export function resetAutoBackup(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  target = null;
}
