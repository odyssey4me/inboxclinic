import { createDexieStore } from "@inboxclinic/store";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import { BrowserGmailClient } from "./gmail/BrowserGmailClient";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

// Public OAuth client id (no secret). Absent in CI/build; required only to sign in.
const clientId = import.meta.env.VITE_OAUTH_CLIENT_ID ?? "";
const gmail = new BrowserGmailClient(clientId);
const store = createDexieStore();

createRoot(rootElement).render(
  <StrictMode>
    <App gmail={gmail} store={store} />
  </StrictMode>,
);

// Register the auto-updating service worker (PWA shell).
registerSW({ immediate: true });
