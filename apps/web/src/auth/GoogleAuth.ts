// SPDX-License-Identifier: Apache-2.0
/**
 * The app's single Google OAuth grant.
 *
 * See docs/design-gmail-integration.md Decisions 1 & 2 and architecture.md §6. Every
 * scope the app uses is requested **once, at sign-in** (`GOOGLE_SCOPES`), and the
 * resulting token is shared by the Gmail and Drive adapters — one grant, one token, two
 * adapters. Nothing here escalates permissions, and nothing is ever persisted: the token
 * lives in this object's memory and dies with the tab.
 *
 * Renewal is silent where the browser allows it, bounded by visibility and idle time so
 * a forgotten background tab cannot hold a live Gmail token indefinitely.
 */

import { GOOGLE_SCOPES } from "@inboxclinic/core";
import type { AccessToken } from "@inboxclinic/core";

import { requestAccessToken } from "./gis";

/** Attempt renewal this long before the token actually expires (`auth.renewLeadMs`). */
const RENEW_LEAD_MS = 5 * 60 * 1000;
/** Let a session lapse rather than renew it after this much user inactivity. */
const IDLE_CAP_MS = 60 * 60 * 1000;
/** User-interaction events that count as activity for the idle cap. */
const ACTIVITY_EVENTS = ["pointerdown", "keydown"] as const;

const SCOPE_STRING = GOOGLE_SCOPES.join(" ");

/**
 * Thrown when a token is needed but the session is unattended (hidden tab, or idle past
 * `IDLE_CAP_MS`), so renewing would mean prompting someone who is not there. Typed so
 * callers can distinguish "let it lapse" from a real failure: a background task drops
 * it, while a user-facing action surfaces the signed-out state.
 */
export class SessionLapsedError extends Error {
  constructor(message = "The Google session lapsed; sign in again to continue") {
    super(message);
    this.name = "SessionLapsedError";
  }
}

export class GoogleAuth {
  private token: AccessToken | null = null;
  /** De-duplicates concurrent callers so a burst of API calls yields one prompt. */
  private inFlight: Promise<AccessToken> | null = null;
  private lastActivityAt = Date.now();

  constructor(private readonly clientId: string) {
    if (typeof document !== "undefined") {
      const note = (): void => {
        this.lastActivityAt = Date.now();
      };
      for (const event of ACTIVITY_EVENTS) {
        document.addEventListener(event, note, { passive: true });
      }
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") note();
      });
    }
  }

  /** True while a usable grant is held — the caller can act without prompting. */
  hasLiveGrant(): boolean {
    return this.token !== null && this.token.expiresAt > Date.now();
  }

  /** Drop the in-memory token. Nothing is persisted, so this is the whole of sign-out. */
  forget(): void {
    this.token = null;
  }

  /** Take the grant with a visible consent prompt. This is sign-in. */
  async authenticate(): Promise<AccessToken> {
    return this.dedupe(() => this.request(false));
  }

  /**
   * Return a usable token, renewing it silently when it is within `RENEW_LEAD_MS` of
   * expiry. Throws {@link SessionLapsedError} rather than prompting when the session is
   * unattended — see {@link renew}.
   */
  async getAccessToken(): Promise<AccessToken> {
    if (this.token !== null && this.token.expiresAt - RENEW_LEAD_MS > Date.now()) {
      return this.token;
    }
    return this.dedupe(() => this.renew());
  }

  /**
   * Collapse concurrent callers onto one request. Sign-in shares this queue with
   * renewal: a background task waking mid-sign-in must join that prompt, not raise a
   * second one alongside it.
   */
  private async dedupe(work: () => Promise<AccessToken>): Promise<AccessToken> {
    if (this.inFlight !== null) return this.inFlight;
    const pending = work();
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      this.inFlight = null;
    }
  }

  private async renew(): Promise<AccessToken> {
    // An unattended session must **lapse**, not prompt. A consent dialog nobody asked
    // for is the exact failure architecture.md §6 rules out — worse here than at
    // sign-in, because there is no task in front of it to explain why it appeared.
    if (!this.isAttended()) {
      throw new SessionLapsedError();
    }
    if (this.token !== null) {
      try {
        return await this.request(true);
      } catch {
        // Expected on Safari/Firefox (third-party cookies) or a lapsed Google session.
        // The visible prompt below is the real answer; swallowing keeps it the only
        // failure the caller ever sees.
      }
    }
    return this.request(false);
  }

  /**
   * Whether someone is plausibly watching: the tab is visible and there has been user
   * interaction within the idle cap. Renewal — silent or visible — happens only for an
   * attended session, so an abandoned tab lets its credential expire rather than
   * quietly holding one open (design-gmail-integration.md Decision 1).
   */
  private isAttended(): boolean {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
    return Date.now() - this.lastActivityAt <= IDLE_CAP_MS;
  }

  private async request(silent: boolean): Promise<AccessToken> {
    if (this.clientId === "") {
      throw new Error("VITE_OAUTH_CLIENT_ID is not configured");
    }
    const response = await requestAccessToken(this.clientId, SCOPE_STRING, { silent });
    this.token = {
      value: response.access_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      grantedScopes: response.scope.split(" "),
    };
    this.lastActivityAt = Date.now();
    return this.token;
  }
}
