// SPDX-License-Identifier: Apache-2.0
/**
 * Shared Google Identity Services (GIS) token-client helper.
 *
 * See docs/design-gmail-integration.md Decision 1 (PKCE public client, in-memory token,
 * silent renewal). This is the raw GIS call; `GoogleAuth` owns the single grant that the
 * Gmail and Drive adapters share. The GIS script is loaded from index.html
 * (`https://accounts.google.com/gsi/client`).
 */

const GIS_POLL_MS = 50;
const GIS_TIMEOUT_MS = 10_000;

/** Resolve once the GIS `oauth2` namespace has loaded, or reject after a timeout. */
function waitForGis(): Promise<typeof google.accounts.oauth2> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2 !== undefined) {
        resolve(oauth2);
      } else if (Date.now() - start > GIS_TIMEOUT_MS) {
        reject(new Error("Google Identity Services failed to load"));
      } else {
        setTimeout(poll, GIS_POLL_MS);
      }
    };
    poll();
  });
}

/**
 * Request an access token for the given space-separated `scope` string via the GIS
 * token client. Resolves with the granted token response (whose `scope` reflects what
 * Google actually granted); rejects on consent errors. Callers hold the token in memory
 * only — never persisted (no refresh token, no secret).
 *
 * With `silent`, GIS is asked for a token **without showing a dialog** (`prompt: ""`),
 * which succeeds when the scopes are already granted and the user's Google session is
 * live. It depends on third-party cookies to `accounts.google.com` — blocked by default
 * in Safari and Firefox — so a silent request is always allowed to fail and fall back to
 * a visible one (design-gmail-integration.md Decision 1).
 */
export async function requestAccessToken(
  clientId: string,
  scope: string,
  options: { silent?: boolean } = {},
): Promise<google.accounts.oauth2.TokenResponse> {
  const oauth2 = await waitForGis();
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (resp) => {
        if (resp.error !== undefined) {
          reject(new Error(resp.error_description ?? resp.error));
        } else {
          resolve(resp);
        }
      },
      error_callback: (err) => reject(new Error(err.message ?? err.type)),
    });
    client.requestAccessToken(options.silent === true ? { prompt: "" } : undefined);
  });
}

/**
 * Revoke `accessToken` and the grant behind it, so the app disappears from the user's
 * Google Account permissions and the next sign-in asks again.
 *
 * Resolves even when revocation fails: the caller is signing the user out, and a
 * network error at Google must not leave them apparently signed in. The local token is
 * dropped regardless — the worst case is a grant that outlives the session, which is
 * where it stood before this existed.
 */
export async function revokeAccessToken(accessToken: string): Promise<void> {
  const oauth2 = await waitForGis();
  return new Promise((resolve) => {
    oauth2.revoke(accessToken, () => {
      resolve();
    });
  });
}
