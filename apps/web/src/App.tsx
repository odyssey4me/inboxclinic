// SPDX-License-Identifier: Apache-2.0
import {
  incrementalSync,
  runScan,
  type BackupClient,
  type GmailClient,
  type IncrementalSyncResult,
  type Store,
} from "@inboxclinic/core";
import { useCallback, useEffect, useState } from "react";

import { AppShell } from "./components/composed/AppShell";
import { Footer } from "./components/composed/Footer";
import { Button } from "./components/ui/Button";
import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { LayoutProvider } from "./layout/LayoutProvider";
import { registerPeriodicSync, SW_SYNC_MESSAGE } from "./pwa/periodicSync";
import { Analytics } from "./screens/Analytics";
import { Dashboard } from "./screens/Dashboard";
import { Settings } from "./screens/Settings";
import { TrustWorkflow } from "./workflow/TrustWorkflow";

const TAGLINE = "Take back control of your inbox — on-device, local-first email triage.";
const OFFLINE_NOTICE = "Offline — Gmail sync paused; local data is available.";
/** Waitlist form URL; falls back to the repo issues page when unconfigured at build time. */
const REQUEST_ACCESS_URL =
  import.meta.env.VITE_REQUEST_ACCESS_URL ?? "https://github.com/odyssey4me/inboxclinic/issues";

type View = "dashboard" | "workflow" | "analytics" | "settings";

export interface AppProps {
  gmail: GmailClient;
  store: Store;
  backup: BackupClient;
  /** Demo mode: an ephemeral in-memory environment; shows the demo banner, skips auth. */
  demo?: boolean;
  /** Pre-set signed-in identity (demo mode seeds this so the shell renders immediately). */
  initialEmail?: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One-line summary of what a refresh changed. */
function summariseSync(result: IncrementalSyncResult): string {
  if (result.sendersAdded > 0) {
    return `${result.sendersAdded} new sender${result.sendersAdded === 1 ? "" : "s"}`;
  }
  if (result.sendersUpdated > 0) {
    return `${result.sendersUpdated} sender${result.sendersUpdated === 1 ? "" : "s"} updated`;
  }
  return "Up to date";
}

export function App(props: AppProps) {
  return (
    <LayoutProvider>
      <AppInner {...props} />
    </LayoutProvider>
  );
}

function AppInner({ gmail, store, backup, demo = false, initialEmail = null }: AppProps) {
  const [email, setEmail] = useState<string | null>(initialEmail);
  const [view, setView] = useState<View>("dashboard");
  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const online = useOnlineStatus();

  // Incremental History-API sync (full scan on first run / stale marker — design M5).
  const sync = useCallback(async () => {
    setError(null);
    setSyncing(true);
    try {
      const result = await incrementalSync(gmail, store, { windowDays: 30 });
      setLastSyncedAt(Date.now());
      setSyncSummary(summariseSync(result));
      setReloadKey((k) => k + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSyncing(false);
    }
  }, [gmail, store]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      await gmail.authenticate();
      setEmail(await gmail.getAccountEmail());
      await sync(); // sync-on-open: keep the local store current right after auth.
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [gmail, sync]);

  // Full rescan — the heavier "rebuild from scratch" path, offered in Settings.
  const scan = useCallback(async () => {
    setError(null);
    setScanning(true);
    try {
      const result = await runScan(gmail, store, { windowDays: 30 });
      setLastSyncedAt(Date.now());
      setSyncSummary(
        `Rescanned ${result.senderCount} sender${result.senderCount === 1 ? "" : "s"}`,
      );
      setReloadKey((k) => k + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setScanning(false);
    }
  }, [gmail, store]);

  // Local-first: render from the stored profile even before (or without) a live token,
  // so the app works offline. Also register Periodic Background Sync (feature-detected).
  useEffect(() => {
    let active = true;
    void (async () => {
      const profile = await store.profile.get();
      if (active && profile !== undefined) {
        setEmail((prev) => prev ?? profile.googleEmail);
        setLastSyncedAt((prev) => prev ?? profile.lastScanAt);
      }
    })();
    void registerPeriodicSync();
    return () => {
      active = false;
    };
  }, [store]);

  // When the service worker wakes on Periodic Background Sync, it messages the page to
  // run the sync (the OAuth token lives here, not in the SW).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string } | null;
      if (data?.type === SW_SYNC_MESSAGE && email !== null) void sync();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [sync, email]);

  if (email === null) {
    return (
      <div className="flex min-h-screen flex-col">
        <main className="mx-auto flex max-w-2xl flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-4xl font-bold tracking-tight">Inbox Clinic</h1>
          <p className="text-lg text-muted">{TAGLINE}</p>
          <Button onClick={() => void signIn()} disabled={!online}>
            Sign in with Google
          </Button>
          <div className="flex flex-col items-center gap-1">
            <Button
              variant="secondary"
              onClick={() => {
                window.location.search = "?demo=1";
              }}
            >
              Explore the demo
            </Button>
            <p className="text-xs text-muted">
              No account needed — sample data, never sent to Google.
            </p>
          </div>
          {!online && (
            <p role="status" className="text-sm text-defer">
              {OFFLINE_NOTICE}
            </p>
          )}
          <a
            href={REQUEST_ACCESS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted underline"
          >
            Request access
          </a>
          {error !== null && (
            <p role="alert" className="text-sm text-block">
              {error}
            </p>
          )}
        </main>
        <Footer />
      </div>
    );
  }

  const content =
    view === "workflow" ? (
      <TrustWorkflow
        store={store}
        gmail={gmail}
        onDone={() => {
          setReloadKey((k) => k + 1);
          setView("dashboard");
        }}
      />
    ) : view === "analytics" ? (
      <Analytics store={store} />
    ) : view === "settings" ? (
      <Settings
        store={store}
        backup={backup}
        online={online}
        onRestored={() => setReloadKey((k) => k + 1)}
        onRescan={() => void scan()}
        rescanning={scanning}
      />
    ) : (
      <Dashboard key={reloadKey} store={store} onStartWorkflow={() => setView("workflow")} />
    );

  return (
    <AppShell
      email={email}
      online={online}
      view={view}
      onNavigate={setView}
      onRefresh={() => void sync()}
      refreshing={syncing}
      lastSyncedAt={lastSyncedAt}
      syncSummary={syncSummary}
      error={error}
      demo={demo}
      onExitDemo={() => {
        window.location.search = "";
      }}
    >
      {content}
    </AppShell>
  );
}

export default App;
