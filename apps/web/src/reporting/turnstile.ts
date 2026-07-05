// SPDX-License-Identifier: Apache-2.0
/**
 * Cloudflare Turnstile client helper (design-error-reporting.md Decision 6 / Phase 5).
 * Loads the Turnstile script on demand and resolves a one-off human-proof token by rendering
 * a managed widget in a centered overlay. Only used when `VITE_TURNSTILE_SITE_KEY` is set; the
 * external script must be allowed by the site CSP (see the deployment runbook).
 *
 * NOTE: this path requires a live Turnstile site key + CSP allowance to verify end-to-end; it
 * is inert (and untested) until those are configured.
 */

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
    },
  ): string;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile !== undefined) return Promise.resolve();
  if (scriptPromise !== null) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Turnstile"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Render a Turnstile widget and resolve a fresh token (rejects on error/expiry). */
export async function requestTurnstileToken(siteKey: string): Promise<string> {
  await loadScript();
  const api = window.turnstile;
  if (api === undefined) throw new Error("Turnstile unavailable");

  return new Promise<string>((resolve, reject) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-40 flex items-center justify-center bg-ink/40";
    const host = document.createElement("div");
    host.className = "rounded-lg bg-surface p-4 shadow-lg";
    overlay.appendChild(host);
    document.body.appendChild(overlay);

    const cleanup = (): void => overlay.remove();

    api.render(host, {
      sitekey: siteKey,
      callback: (token) => {
        resolve(token);
        cleanup();
      },
      "error-callback": () => {
        reject(new Error("Verification failed"));
        cleanup();
      },
      "expired-callback": () => {
        reject(new Error("Verification expired"));
        cleanup();
      },
    });
  });
}
