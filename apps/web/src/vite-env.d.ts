/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public Google OAuth client id (no secret). Read at runtime; not required to build. */
  readonly VITE_OAUTH_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
