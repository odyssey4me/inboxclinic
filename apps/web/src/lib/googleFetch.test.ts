// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import { backoffDelay, fetchWithRetry, parseRetryAfter } from "./googleFetch";

/** A JSON Response with an optional Retry-After header. */
function jsonResponse(status: number, body: unknown = {}, retryAfter?: string): Response {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("Retry-After", retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}

const noSleep = { sleep: async (): Promise<void> => undefined, random: () => 0 };

afterEach(() => vi.restoreAllMocks());

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("2", 0)).toBe(2000);
  });

  it("reads an HTTP date relative to now", () => {
    const now = Date.parse("2026-07-05T00:00:00Z");
    expect(parseRetryAfter("Sun, 05 Jul 2026 00:00:03 GMT", now)).toBe(3000);
  });

  it("is null for absent or unparseable values", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("  ", 0)).toBeNull();
    expect(parseRetryAfter("not-a-date", 0)).toBeNull();
  });

  it("never returns a negative delay for a past date", () => {
    const now = Date.parse("2026-07-05T00:00:10Z");
    expect(parseRetryAfter("Sun, 05 Jul 2026 00:00:00 GMT", now)).toBe(0);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffDelay(0, 500, 20_000, () => 1)).toBe(500);
    expect(backoffDelay(1, 500, 20_000, () => 1)).toBe(1000);
    expect(backoffDelay(10, 500, 20_000, () => 1)).toBe(20_000); // capped
  });

  it("applies full jitter in [delay/2, delay]", () => {
    expect(backoffDelay(0, 500, 20_000, () => 0)).toBe(250);
    expect(backoffDelay(0, 500, 20_000, () => 1)).toBe(500);
  });
});

describe("fetchWithRetry", () => {
  it("retries a 429 then returns the eventual success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const response = await fetchWithRetry("https://gmail/x", undefined, noSleep);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After for the backoff delay", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(503, {}, "2"))
      .mockResolvedValueOnce(jsonResponse(200));
    const sleep = vi.fn(async (): Promise<void> => undefined);

    await fetchWithRetry("https://gmail/x", undefined, { sleep, random: () => 0 });

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("retries transient 5xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200));

    const response = await fetchWithRetry("https://gmail/x", undefined, noSleep);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable statuses (e.g. 400)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(400));

    const response = await fetchWithRetry("https://gmail/x", undefined, noSleep);

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the last response after exhausting retries", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(429));

    const response = await fetchWithRetry("https://gmail/x", undefined, {
      ...noSleep,
      maxRetries: 3,
    });

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("retries a 403 rate-limit but keeps the body readable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }),
      )
      .mockResolvedValueOnce(jsonResponse(200));

    const response = await fetchWithRetry("https://gmail/x", undefined, noSleep);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 403 permission error", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }),
      );

    const response = await fetchWithRetry("https://gmail/x", undefined, noSleep);

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a network error then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(jsonResponse(200));

    const response = await fetchWithRetry("https://gmail/x", undefined, noSleep);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows a network error once retries are exhausted", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));

    await expect(
      fetchWithRetry("https://gmail/x", undefined, { ...noSleep, maxRetries: 2 }),
    ).rejects.toThrow("network");
  });
});
