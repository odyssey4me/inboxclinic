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
