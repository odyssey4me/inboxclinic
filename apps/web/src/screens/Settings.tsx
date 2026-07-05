// SPDX-License-Identifier: Apache-2.0
import {
  backupToDrive,
  BackupNotFoundError,
  getBackupState,
  restoreFromDrive,
  setBackupEnabled,
  type BackupClient,
  type BackupState,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

export interface SettingsProps {
  store: Store;
  backup: BackupClient;
  online: boolean;
  /** Called after a successful restore so the app can reload its view of the store. */
  onRestored: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatWhen(epochMs: number | null): string {
  return epochMs === null ? "never" : new Date(epochMs).toLocaleString();
}

/** Settings: opt-in Google Drive backup, manual back-up-now, and replace-local restore. */
export function Settings({ store, backup, online, onRestored }: SettingsProps) {
  const [state, setState] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const loaded = await getBackupState(store);
      if (active) setState(loaded);
    })();
    return () => {
      active = false;
    };
  }, [store]);

  if (state === null) {
    return <p className="p-6 text-center text-slate-500">Loading settings…</p>;
  }

  const reload = async (): Promise<void> => {
    setState(await getBackupState(store));
  };

  // Enabling requests incremental drive.file consent; a decline reverts the toggle.
  const onToggle = async (): Promise<void> => {
    setNote(null);
    setError(null);
    const next = !state.enabled;
    try {
      if (next) {
        await setBackupEnabled(store, true);
        await backup.authorize();
        setNote("Backup enabled. Use “Back up now” to save a copy to your Drive.");
      } else {
        await setBackupEnabled(store, false);
        setNote("Backup disabled. Your existing Drive backup is left untouched.");
      }
      await reload();
    } catch (caught) {
      await setBackupEnabled(store, false);
      await reload();
      setError(`Could not enable backup: ${errorMessage(caught)}`);
    }
  };

  const onBackupNow = async (): Promise<void> => {
    setNote(null);
    setError(null);
    setBusy("backup");
    try {
      const result = await backupToDrive(backup, store);
      await reload();
      setNote(
        `${result.created ? "Created" : "Updated"} “Inbox Clinic Backup.json” in your Drive.`,
      );
    } catch (caught) {
      setError(`Backup failed: ${errorMessage(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const onConfirmRestore = async (): Promise<void> => {
    setNote(null);
    setError(null);
    setBusy("restore");
    try {
      await restoreFromDrive(backup, store);
      await reload();
      setConfirmingRestore(false);
      setNote("Restore complete. Local data was replaced with your Drive backup.");
      onRestored();
    } catch (caught) {
      setConfirmingRestore(false);
      setError(
        caught instanceof BackupNotFoundError
          ? "No backup was found in your Drive yet — back up first."
          : `Restore failed: ${errorMessage(caught)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const actionsDisabled = !state.enabled || !online || busy !== null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
      <h2 className="text-2xl font-bold tracking-tight">Settings</h2>

      <Card aria-label="Google Drive backup" className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Back up to Google Drive</h2>
            <p className="text-sm text-slate-500">
              Save an encryptable copy of your on-device data to your own Google Drive. Inbox Clinic
              requests the least-permission <code>drive.file</code> scope, which can only see the
              single backup file it creates — never the rest of your Drive.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={state.enabled}
              onChange={() => void onToggle()}
              aria-label="Enable Google Drive backup"
            />
            {state.enabled ? "On" : "Off"}
          </label>
        </div>

        <dl className="flex justify-between border-t border-slate-100 pt-3 text-sm">
          <dt className="text-slate-500">Last backup</dt>
          <dd className="tabular-nums text-slate-700">{formatWhen(state.lastBackupAt)}</dd>
        </dl>

        {!online && (
          <p role="status" className="text-sm text-amber-600">
            Offline — connect to back up or restore.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void onBackupNow()} disabled={actionsDisabled}>
            {busy === "backup" ? "Backing up…" : "Back up now"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setNote(null);
              setError(null);
              setConfirmingRestore(true);
            }}
            disabled={actionsDisabled}
          >
            Restore from backup
          </Button>
        </div>

        {confirmingRestore && (
          <div
            role="alertdialog"
            aria-label="Confirm restore"
            className="space-y-3 rounded-md border border-red-200 bg-red-50 p-3"
          >
            <p className="text-sm text-red-800">
              Restoring <strong>replaces all data on this device</strong> with the contents of your
              Drive backup. This cannot be undone. Continue?
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                onClick={() => void onConfirmRestore()}
                disabled={busy !== null}
              >
                {busy === "restore" ? "Restoring…" : "Replace local data"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingRestore(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {note !== null && (
          <p role="status" className="text-sm text-emerald-700">
            {note}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}
