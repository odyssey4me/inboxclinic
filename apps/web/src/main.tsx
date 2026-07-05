// SPDX-License-Identifier: Apache-2.0
import { createDexieStore } from "@inboxclinic/store";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
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
  const gmail = new BrowserGmailClient(clientId);
  const backup = new BrowserDriveClient(clientId);
  const store = createDexieStore();

  root.render(
    <StrictMode>
      <App gmail={gmail} store={store} backup={backup} />
    </StrictMode>,
  );

  // Register the auto-updating service worker (PWA shell) — skipped in demo mode.
  registerSW({ immediate: true });
}

void bootstrap();
