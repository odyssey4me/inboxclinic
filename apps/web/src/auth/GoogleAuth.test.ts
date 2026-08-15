// SPDX-License-Identifier: Apache-2.0
import { GOOGLE_SCOPES } from "@inboxclinic/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleAuth, SessionLapsedError } from "./GoogleAuth";
import { requestAccessToken } from "./gis";

vi.mock("./gis", () => ({ requestAccessToken: vi.fn() }));

const mockRequest = vi.mocked(requestAccessToken);

/** A GIS token response with a controllable lifetime. */
function tokenResponse(expiresIn: number): google.accounts.oauth2.TokenResponse {
  return {
    access_token: `token-${String(expiresIn)}`,
    expires_in: expiresIn,
    scope: GOOGLE_SCOPES.join(" "),
    token_type: "Bearer",
  } as google.accounts.oauth2.TokenResponse;
}

/** The `silent` flag of each call, in order — the thing every assertion here is about. */
function silentFlags(): boolean[] {
  return mockRequest.mock.calls.map((call) => call[2]?.silent === true);
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("GoogleAuth", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    setVisibility("visible");
  });

  it("requests every scope in one grant", async () => {
    mockRequest.mockResolvedValue(tokenResponse(3600));
    await new GoogleAuth("client-id").authenticate();

    expect(mockRequest).toHaveBeenCalledOnce();
    expect(mockRequest.mock.calls[0]?.[1]).toBe(GOOGLE_SCOPES.join(" "));
    expect(silentFlags()).toEqual([false]);
  });

  it("reuses the token rather than prompting again", async () => {
    mockRequest.mockResolvedValue(tokenResponse(3600));
    const auth = new GoogleAuth("client-id");

    await auth.authenticate();
    await auth.getAccessToken();
    await auth.getAccessToken();

    expect(mockRequest).toHaveBeenCalledOnce();
  });

  it("renews silently as the token nears expiry", async () => {
    // 4 minutes left is inside the 5-minute renewal lead.
    mockRequest
      .mockResolvedValueOnce(tokenResponse(240))
      .mockResolvedValueOnce(tokenResponse(3600));
    const auth = new GoogleAuth("client-id");
    await auth.authenticate();

    const renewed = await auth.getAccessToken();

    expect(silentFlags()).toEqual([false, true]);
    expect(renewed.value).toBe("token-3600");
  });

  it("falls back to a visible prompt when silent renewal fails", async () => {
    // Safari/Firefox third-party-cookie blocking, or a lapsed Google session.
    mockRequest
      .mockResolvedValueOnce(tokenResponse(240))
      .mockRejectedValueOnce(new Error("popup_blocked"))
      .mockResolvedValueOnce(tokenResponse(3600));
    const auth = new GoogleAuth("client-id");
    await auth.authenticate();

    const renewed = await auth.getAccessToken();

    expect(silentFlags()).toEqual([false, true, false]);
    expect(renewed.value).toBe("token-3600");
  });

  it("lets the session lapse in a backgrounded tab instead of prompting", async () => {
    // A forgotten tab must neither hold a credential open nor throw a consent dialog at
    // someone who is not there — the second is the worse of the two.
    mockRequest
      .mockResolvedValueOnce(tokenResponse(240))
      .mockResolvedValueOnce(tokenResponse(3600));
    const auth = new GoogleAuth("client-id");
    await auth.authenticate();
    setVisibility("hidden");

    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(SessionLapsedError);
    expect(mockRequest).toHaveBeenCalledOnce(); // only the original sign-in
  });

  it("lets the session lapse once the user has been idle past the cap", async () => {
    vi.useFakeTimers();
    try {
      mockRequest.mockResolvedValue(tokenResponse(3600));
      const auth = new GoogleAuth("client-id");
      await auth.authenticate();

      // Past both the token's life and the one-hour idle cap, with no interaction.
      vi.advanceTimersByTime(2 * 60 * 60 * 1000);

      await expect(auth.getAccessToken()).rejects.toBeInstanceOf(SessionLapsedError);
      expect(mockRequest).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews again after the user comes back to the tab", async () => {
    mockRequest
      .mockResolvedValueOnce(tokenResponse(240))
      .mockResolvedValueOnce(tokenResponse(3600));
    const auth = new GoogleAuth("client-id");
    await auth.authenticate();
    setVisibility("hidden");
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(SessionLapsedError);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    await expect(auth.getAccessToken()).resolves.toMatchObject({ value: "token-3600" });
  });

  it("joins a background caller onto an in-flight sign-in rather than prompting twice", async () => {
    let release: (value: google.accounts.oauth2.TokenResponse) => void = () => {};
    mockRequest.mockImplementationOnce(
      () =>
        new Promise<google.accounts.oauth2.TokenResponse>((resolve) => {
          release = resolve;
        }),
    );
    const auth = new GoogleAuth("client-id");

    const signIn = auth.authenticate();
    const background = auth.getAccessToken(); // e.g. the auto-backup timer firing
    release(tokenResponse(3600));

    await expect(Promise.all([signIn, background])).resolves.toHaveLength(2);
    expect(mockRequest).toHaveBeenCalledOnce();
  });

  it("drops the token on sign-out", async () => {
    mockRequest.mockResolvedValue(tokenResponse(3600));
    const auth = new GoogleAuth("client-id");
    await auth.authenticate();
    expect(auth.hasLiveGrant()).toBe(true);

    auth.forget();

    expect(auth.hasLiveGrant()).toBe(false);
  });

  it("collapses concurrent callers into a single prompt", async () => {
    mockRequest
      .mockResolvedValueOnce(tokenResponse(240))
      .mockResolvedValueOnce(tokenResponse(3600));
    const auth = new GoogleAuth("client-id");
    await auth.authenticate();

    await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);

    expect(mockRequest).toHaveBeenCalledTimes(2); // the initial grant + one renewal
  });

  it("fails clearly when no OAuth client id is configured", async () => {
    await expect(new GoogleAuth("").authenticate()).rejects.toThrow("VITE_OAUTH_CLIENT_ID");
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
