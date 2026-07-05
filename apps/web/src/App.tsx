// SPDX-License-Identifier: Apache-2.0
import {
  incrementalSync,
  runScan,
  type BackupClient,
  type GmailClient,
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App(props: AppProps) {
  return (
    <LayoutProvider>
      <AppInner {...props} />
    </LayoutProvider>
  );
}

function AppInner({ gmail, store, backup }: AppProps) {
  const [email, setEmail] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const online = useOnlineStatus();

  // Incremental History-API sync (full scan on first run / stale marker — design M5).
  const sync = useCallback(async () => {
    setError(null);
    setSyncing(true);
    try {
      await incrementalSync(gmail, store, { windowDays: 30 });
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

  const scan = useCallback(async () => {
    setError(null);
    setScanning(true);
    try {
      await runScan(gmail, store, { windowDays: 30 });
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
      if (active && profile !== undefined) setEmail((prev) => prev ?? profile.googleEmail);
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
      onSync={() => void sync()}
      onScan={() => void scan()}
      syncing={syncing}
      scanning={scanning}
      error={error}
    >
      {content}
    </AppShell>
  );
}

export default App;
