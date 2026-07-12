// SPDX-License-Identifier: Apache-2.0
/**
 * `redact` — strip personally-identifying or secret material from a diagnostic string
 * before it is shown to the user or submitted (design-error-reporting.md Decision 3).
 *
 * Pure and deterministic. Applied to error messages / stack traces so that, e.g.,
 * `…429 for /messages/19efa38b32b35328?…` becomes `…429 for /messages/[id]?…`. Header
 * *names* (e.g. `metadataHeaders=Subject`) are intentionally preserved — only *values*
 * that could identify the user (addresses, tokens, message/thread ids, subject text) are
 * masked. The user still reviews the result before anything leaves the device.
 */

/** Ordered redaction rules; each is applied in turn. Order matters (tokens before emails). */
const RULES: { pattern: RegExp; replacement: string }[] = [
  // OAuth bearer tokens and Google `ya29.` access tokens.
  { pattern: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: "Bearer [token]" },
  { pattern: /ya29\.[A-Za-z0-9._~+/-]+/g, replacement: "[token]" },
  // `access_token=…`, `id_token=…`, `refresh_token=…`, `token=…` in query strings/JSON.
  {
    pattern: /((?:access_|id_|refresh_)?token)["']?\s*[=:]\s*["']?[^&\s"',}]+/gi,
    replacement: "$1=[token]",
  },
  // Gmail message/thread ids in REST paths (hex, ≥8 chars — never matches `batchModify`).
  { pattern: /\/(messages|threads)\/[0-9a-f]{8,}/gi, replacement: "/$1/[id]" },
  // Subject values (query param or header) — but not the header *name* `metadataHeaders=Subject`.
  { pattern: /([?&]subject=)[^&\s]*/gi, replacement: "$1[subject]" },
  { pattern: /(^|\n)(subject:\s*).*/gi, replacement: "$1$2[subject]" },
  // Email addresses (broad; run last so it doesn't eat token/id captures).
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[email]" },
];

/** Redact a single string. Safe on `undefined`/empty (returns `""`). */
export function redact(text: string | undefined): string {
  if (text === undefined || text === "") return "";
  return RULES.reduce((acc, { pattern, replacement }) => acc.replace(pattern, replacement), text);
}
