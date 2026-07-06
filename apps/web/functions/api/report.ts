// SPDX-License-Identifier: Apache-2.0
/**
 * Cloudflare Pages Function — anonymous feedback intake (design-error-reporting.md
 * Decisions 2 & 6 / Phase 5). Same-origin `POST /api/report`. In order: size cap → parse +
 * validate → Turnstile verify → KV rate-limit (per client-IP hash and per install ID) →
 * create an anonymous GitHub issue. The raw install ID and client IP are never written to
 * the issue; only a short `client:<hash>` label is (see reportIntake.ts).
 *
 * Bindings/secrets (configured in the Pages project, never in Git): GITHUB_TOKEN (fine-
 * grained PAT, issues-write), TURNSTILE_SECRET, REPORT_KV (KV namespace). Optional
 * GITHUB_REPO overrides the target repo.
 */

import {
  issueFromReport,
  MAX_BODY_BYTES,
  rateLimitKey,
  validateSubmission,
} from "../../src/reporting/reportIntake";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  GITHUB_TOKEN: string;
  TURNSTILE_SECRET: string;
  REPORT_KV: KVNamespace;
  GITHUB_REPO?: string;
}

interface PagesContext {
  request: Request;
  env: Env;
}

const DEFAULT_REPO = "odyssey4me/inboxclinic";
// Fixed-window limits (per hour) — Turnstile is the real gate; these bound bursts.
const IP_LIMIT = 8;
const ID_LIMIT = 12;
const WINDOW_SECONDS = 3600;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** SHA-256 → first 16 hex chars. Used so the client IP is never stored raw in KV. */
async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Fixed-window increment; returns false when the limit for `key` is already reached. */
async function withinLimit(kv: KVNamespace, key: string, limit: number): Promise<boolean> {
  const current = Number.parseInt((await kv.get(key)) ?? "0", 10);
  if (current >= limit) return false;
  await kv.put(key, String(current + 1), { expirationTtl: WINDOW_SECONDS });
  return true;
}

async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | null,
): Promise<{ ok: boolean; codes: string[] }> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip !== null) form.set("remoteip", ip);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const outcome = (await response.json()) as { success?: boolean; "error-codes"?: string[] };
  return { ok: outcome.success === true, codes: outcome["error-codes"] ?? [] };
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env } = context;

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "payload too large" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid json" });
  }

  const validation = validateSubmission(parsed);
  if (!validation.ok) return json(400, { error: validation.error });
  const { report, turnstileToken } = validation.submission;

  // Turnstile is the primary human-proof gate.
  const verdict = await verifyTurnstile(
    env.TURNSTILE_SECRET,
    turnstileToken,
    request.headers.get("CF-Connecting-IP"),
  );
  if (!verdict.ok) {
    // Surface the Turnstile error codes (non-sensitive) so a failure is diagnosable.
    return json(403, { error: "verification failed", codes: verdict.codes });
  }

  // Rate-limit on a hashed IP and on the install ID (defence in depth).
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipKey = rateLimitKey("ip", await hashIp(ip));
  const idKey = rateLimitKey("id", report.installId);
  if (!(await withinLimit(env.REPORT_KV, ipKey, IP_LIMIT))) {
    return json(429, { error: "rate limited" });
  }
  if (!(await withinLimit(env.REPORT_KV, idKey, ID_LIMIT))) {
    return json(429, { error: "rate limited" });
  }

  const repo = env.GITHUB_REPO ?? DEFAULT_REPO;
  const issue = issueFromReport(report);
  const created = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "inboxclinic-feedback",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(issue),
  });
  if (!created.ok) return json(502, { error: "could not create issue" });

  const data = (await created.json()) as { html_url?: string };
  return json(200, { ref: data.html_url ?? "" });
}
