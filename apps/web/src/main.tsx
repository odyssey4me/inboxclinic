// SPDX-License-Identifier: Apache-2.0
import { createDexieStore } from "@inboxclinic/store";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import { GoogleAuth } from "./auth/GoogleAuth";
import { initAutoBackup } from "./backup/autoBackup";
import { BrowserDriveClient } from "./backup/BrowserDriveClient";
import { BrowserGmailClient } from "./gmail/BrowserGmailClient";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}
const root = createRoot(rootElement);

const isDemo = new URLSearchParams(window.location.search).has("demo");

async function bootstrap(): Promise<void> {
  if (isDemo) {
    // Demo mode: an ephemeral, in-memory, no-Google environment (design-frontend.md).
    // Lazy-loaded so the demo engine + fixtures never ship in the normal path.
    const { createDemoEnvironment } = await import("@inboxclinic/core/demo");
    const { gmail, store, backup } = await createDemoEnvironment();
    initAutoBackup(backup, store);
    const profile = await store.profile.get();
    root.render(
      <StrictMode>
        <App
          gmail={gmail}
          store={store}
          backup={backup}
          demo
          initialEmail={profile?.googleEmail ?? null}
        />
      </StrictMode>,
    );
    return;
  }

  // Public OAuth client id (no secret). Absent in CI/build; required only to sign in.
  const clientId = import.meta.env.VITE_OAUTH_CLIENT_ID ?? "";
  // One grant, one token, two adapters (design-gmail-integration.md Decision 2).
  const auth = new GoogleAuth(clientId);
  const gmail = new BrowserGmailClient(auth);
  const backup = new BrowserDriveClient(auth);
  const store = createDexieStore();
  // The grant check keeps a timer-driven backup from ever raising a consent prompt.
  initAutoBackup(backup, store, () => auth.hasLiveGrant());

  root.render(
    <StrictMode>
      <App
        gmail={gmail}
        store={store}
        backup={backup}
        onSignOut={() => {
          void auth.signOut();
        }}
      />
    </StrictMode>,
  );

  // Register the auto-updating service worker (PWA shell) — skipped in demo mode.
  registerSW({ immediate: true });
}

void bootstrap();
