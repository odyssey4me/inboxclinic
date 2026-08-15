// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal ambient types for the Google Identity Services (GIS) token-client flow.
 *
 * See docs/design-gmail-integration.md Decision 1 (PKCE public client, in-memory
 * token). We declare only the small surface the browser adapter uses so `tsc` passes
 * without pulling in a heavy `@types/google.accounts` dependency. The GIS script is
 * loaded from index.html (`https://accounts.google.com/gsi/client`).
 */

export {};

declare global {
  namespace google.accounts.oauth2 {
    interface TokenResponse {
      access_token: string;
      expires_in: number;
      scope: string;
      token_type: string;
      error?: string;
      error_description?: string;
    }

    interface TokenClientConfig {
      client_id: string;
      scope: string;
      callback: (response: TokenResponse) => void;
      error_callback?: (error: { type: string; message?: string }) => void;
      prompt?: string;
    }

    interface TokenClient {
      requestAccessToken(overrideConfig?: { prompt?: string }): void;
    }

    function initTokenClient(config: TokenClientConfig): TokenClient;

    /**
     * Revoke a token and the grant behind it. `done` receives a status object we do
     * not act on: sign-out clears local state either way (Decision 1).
     */
    function revoke(accessToken: string, done?: () => void): void;
  }

  interface Window {
    google?: typeof google;
  }
}
