// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Google OAuth client id (no secret). Read at runtime; not required to build. */
  readonly VITE_OAUTH_CLIENT_ID?: string;
  /** URL of the hosted request-access (waitlist) form; falls back to the repo issues page. */
  readonly VITE_REQUEST_ACCESS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build-stamp constants injected via Vite `define` (vite.config.ts). Short commit SHA… */
declare const __APP_COMMIT__: string;
/** …and the ISO build time. */
declare const __APP_BUILT_AT__: string;
