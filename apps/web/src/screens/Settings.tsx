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
  /** Trigger a full inbox rescan (the heavier rebuild path). */
  onRescan: () => void;
  rescanning: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatWhen(epochMs: number | null): string {
  return epochMs === null ? "never" : new Date(epochMs).toLocaleString();
}

/** Trigger a client-side download of `json` text as a named JSON file (no network). */
function downloadJson(filename: string, json: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Settings: opt-in Google Drive backup, manual back-up-now, and replace-local restore. */
export function Settings({
  store,
  backup,
  online,
  onRestored,
  onRescan,
  rescanning,
}: SettingsProps) {
  const [state, setState] = useState<BackupState | null>(null);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingWipe, setConfirmingWipe] = useState(false);
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
    return <p className="p-6 text-center text-muted">Loading settings…</p>;
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

  const onExport = async (): Promise<void> => {
    setNote(null);
    setError(null);
    try {
      const json = new TextDecoder().decode(await store.exportAll());
      downloadJson("inbox-clinic-data.json", json);
      setNote("Exported a copy of your on-device data.");
    } catch (caught) {
      setError(`Export failed: ${errorMessage(caught)}`);
    }
  };

  const onConfirmWipe = async (): Promise<void> => {
    try {
      await store.wipeAll();
      // Reload to a clean state (signed-out landing, or a fresh demo seed).
      window.location.reload();
    } catch (caught) {
      setConfirmingWipe(false);
      setError(`Delete failed: ${errorMessage(caught)}`);
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
            <p className="text-sm text-muted">
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

        <dl className="flex justify-between border-t border-line pt-3 text-sm">
          <dt className="text-muted">Last backup</dt>
          <dd className="tabular-nums text-ink">{formatWhen(state.lastBackupAt)}</dd>
        </dl>

        {!online && (
          <p role="status" className="text-sm text-defer">
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
            className="space-y-3 rounded-md border border-block/30 bg-block/10 p-3"
          >
            <p className="text-sm text-block">
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
      </Card>

      <Card aria-label="Your data" className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Your data</h2>
          <p className="text-sm text-muted">
            Everything Inbox Clinic knows lives on this device. Export a copy any time, or erase it
            completely — your Gmail and any Drive backup are never touched.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void onExport()}>
            Export my data (JSON)
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setNote(null);
              setError(null);
              setConfirmingWipe(true);
            }}
          >
            Delete all local data
          </Button>
        </div>

        {confirmingWipe && (
          <div
            role="alertdialog"
            aria-label="Confirm delete"
            className="space-y-3 rounded-md border border-block/30 bg-block/10 p-3"
          >
            <p className="text-sm text-block">
              This permanently erases <strong>all Inbox Clinic data on this device</strong> —
              senders, decisions, and analytics. This cannot be undone.
            </p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={() => void onConfirmWipe()}>
                Delete everything
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingWipe(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card aria-label="Rescan inbox" className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Rescan inbox</h2>
          <p className="text-sm text-muted">
            Rebuild your sender list from a fresh full scan of the last 30 days. Inbox Clinic
            normally keeps up automatically with <strong>Refresh</strong> — use this only if
            something looks out of date.
          </p>
        </div>
        <Button variant="secondary" onClick={onRescan} disabled={rescanning || !online}>
          {rescanning ? "Rescanning…" : "Rescan inbox"}
        </Button>
      </Card>

      {note !== null && (
        <p role="status" className="text-sm text-accent-ink">
          {note}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-block">
          {error}
        </p>
      )}
    </div>
  );
}
