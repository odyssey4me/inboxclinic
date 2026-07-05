// SPDX-License-Identifier: Apache-2.0
/**
 * `fetchWithRetry` — a thin wrapper around `fetch` that retries transient Google API
 * failures with exponential backoff + jitter, honouring `Retry-After` when present.
 *
 * Google's Gmail/Drive REST APIs rate-limit per-user and return **429** (and occasionally
 * **403 rateLimitExceeded / userRateLimitExceeded**); they also emit transient **5xx** and
 * **408**. design-gmail-integration.md and design-frontend.md (Error Handling) call for
 * recoverable Google calls to be retried with backoff so a transient limit self-heals
 * instead of surfacing as an error. Non-retryable responses (400/401/403-permission/404…)
 * are returned unchanged for the caller to handle (e.g. 404 → StaleHistoryError).
 *
 * The clock and RNG are injectable so the backoff is deterministically testable.
 */

export interface RetryOptions {
  /** Maximum retries after the initial attempt (default 5). */
  maxRetries?: number;
  /** Base delay for the first backoff, in ms (default 500). */
  baseDelayMs?: number;
  /** Upper bound on any single backoff, in ms (default 20_000). */
  maxDelayMs?: number;
  /** Injectable sleep (default `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG in [0, 1) for jitter (default `Math.random`). */
  random?: () => number;
  /** Injectable clock for `Retry-After` HTTP-date maths (default `Date.now`). */
  now?: () => number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 20_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a `Retry-After` header (delta-seconds or an HTTP date) into milliseconds from now,
 * or `null` when absent/unparseable. Never negative.
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - now);
}

/** Exponential backoff with "full jitter" in `[delay/2, delay]`. */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/** Retryable purely by status: request timeout, rate limit, or a transient server error. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/**
 * A 403 is retryable only when it is a *rate* limit (self-heals on backoff), not a
 * permission error or a daily quota (which will not recover in seconds). Inspects a clone
 * so the original body stays readable for the caller.
 */
async function is403RateLimit(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const data = (await response.clone().json()) as {
      error?: { errors?: { reason?: string }[]; status?: string };
    };
    const reason = data.error?.errors?.[0]?.reason ?? data.error?.status;
    return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
  } catch {
    return false;
  }
}

/**
 * `fetch` with retry/backoff for transient Google API failures. Resolves with the final
 * `Response` (whether ok, non-retryable, or the last response after exhausting retries).
 * Network errors are retried too; the last one is rethrown if retries run out.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, random));
      continue;
    }

    const retryable = isRetryableStatus(response.status) || (await is403RateLimit(response));
    if (!retryable || attempt >= maxRetries) return response;

    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"), now());
    await sleep(retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, random));
  }
}
