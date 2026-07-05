import { trustTier } from "@inboxclinic/core";

const TAGLINE = "Take back control of your inbox — on-device, local-first email triage.";

export function App() {
  // Exercise the workspace link to @inboxclinic/core so the shell proves the
  // monorepo wiring end-to-end. The full trust UI arrives in a later milestone.
  const exampleTier = trustTier(10);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Inbox Clinic</h1>
      <p className="text-lg text-slate-600">{TAGLINE}</p>
      <p className="text-sm text-slate-400">Core link OK — example tier: {exampleTier.tier}</p>
    </main>
  );
}

export default App;
