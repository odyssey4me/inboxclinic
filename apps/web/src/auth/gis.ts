// SPDX-License-Identifier: Apache-2.0
/**
 * Shared Google Identity Services (GIS) token-client helper.
 *
 * See docs/design-gmail-integration.md Decision 1 (PKCE public client, in-memory token)
 * and docs/design-backup-restore.md Decision 2 (incremental `drive.file` consent). Both
 * the Gmail adapter and the Drive backup adapter acquire short-lived access tokens the
 * same way — via `initTokenClient` for a given scope string — so that flow lives here
 * once. The GIS script is loaded from index.html (`https://accounts.google.com/gsi/client`).
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
 */
export async function requestAccessToken(
  clientId: string,
  scope: string,
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
    client.requestAccessToken();
  });
}
