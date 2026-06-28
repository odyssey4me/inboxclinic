import { runScan } from "@inboxclinic/core";
import type { GmailClient, Sender, Store } from "@inboxclinic/core";
import { useCallback, useState } from "react";

const TAGLINE = "Take back control of your inbox — on-device, local-first email triage.";

type Phase = "signed-out" | "ready" | "scanning";

export interface AppProps {
  gmail: GmailClient;
  store: Store;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App({ gmail, store }: AppProps) {
  const [phase, setPhase] = useState<Phase>("signed-out");
  const [email, setEmail] = useState<string | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      await gmail.authenticate();
      setEmail(await gmail.getAccountEmail());
      setPhase("ready");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [gmail]);

  const scan = useCallback(async () => {
    setError(null);
    setPhase("scanning");
    try {
      await runScan(gmail, store, { windowDays: 30 });
      const rows = await store.senders.query({});
      rows.sort((a, b) => b.totalEmails - a.totalEmails);
      setSenders(rows);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPhase("ready");
    }
  }, [gmail, store]);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Inbox Clinic</h1>
        <p className="mt-2 text-lg text-slate-600">{TAGLINE}</p>
      </header>

      {email === null ? (
        <section className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => void signIn()}
            className="rounded-md bg-slate-900 px-5 py-2.5 font-medium text-white hover:bg-slate-700"
          >
            Sign in with Google
          </button>
          <a href="#request-access" className="text-sm text-slate-500 underline">
            Request access
          </a>
        </section>
      ) : (
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">
              Signed in as <span className="font-medium text-slate-900">{email}</span>
            </p>
            <button
              type="button"
              onClick={() => void scan()}
              disabled={phase === "scanning"}
              className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {phase === "scanning" ? "Scanning…" : "Scan inbox"}
            </button>
          </div>

          {senders.length > 0 && (
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-300 text-slate-500">
                  <th className="py-2 pr-4 font-medium">Sender</th>
                  <th className="py-2 pr-4 font-medium">Domain</th>
                  <th className="py-2 pr-4 font-medium">Category</th>
                  <th className="py-2 text-right font-medium">Emails</th>
                </tr>
              </thead>
              <tbody>
                {senders.map((sender) => (
                  <tr key={sender.id} className="border-b border-slate-100">
                    <td className="py-2 pr-4">{sender.email}</td>
                    <td className="py-2 pr-4 text-slate-500">{sender.domain}</td>
                    <td className="py-2 pr-4 text-slate-500">{sender.category}</td>
                    <td className="py-2 text-right tabular-nums">{sender.totalEmails}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {error !== null && (
        <p role="alert" className="text-center text-sm text-red-600">
          {error}
        </p>
      )}
    </main>
  );
}

export default App;
