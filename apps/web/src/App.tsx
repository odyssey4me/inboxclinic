import { runScan, type GmailClient, type Store } from "@inboxclinic/core";
import { useCallback, useState } from "react";

import { Button } from "./components/ui/Button";
import { Dashboard } from "./screens/Dashboard";
import { TrustWorkflow } from "./workflow/TrustWorkflow";

const TAGLINE = "Take back control of your inbox — on-device, local-first email triage.";

type View = "dashboard" | "workflow";

export interface AppProps {
  gmail: GmailClient;
  store: Store;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App({ gmail, store }: AppProps) {
  const [email, setEmail] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [scanning, setScanning] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      await gmail.authenticate();
      setEmail(await gmail.getAccountEmail());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [gmail]);

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

  if (email === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Inbox Clinic</h1>
        <p className="text-lg text-slate-600">{TAGLINE}</p>
        <Button onClick={() => void signIn()}>Sign in with Google</Button>
        <a href="#request-access" className="text-sm text-slate-500 underline">
          Request access
        </a>
        {error !== null && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </main>
    );
  }

  if (view === "workflow") {
    return (
      <TrustWorkflow
        store={store}
        onDone={() => {
          setReloadKey((k) => k + 1);
          setView("dashboard");
        }}
      />
    );
  }

  return (
    <>
      <Dashboard
        key={reloadKey}
        store={store}
        email={email}
        scanning={scanning}
        onScan={() => void scan()}
        onStartWorkflow={() => setView("workflow")}
      />
      {error !== null && (
        <p role="alert" className="px-4 pb-4 text-center text-sm text-red-600">
          {error}
        </p>
      )}
    </>
  );
}

export default App;
