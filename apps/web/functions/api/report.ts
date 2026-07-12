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

/**
 * A staged error response. `stage` pinpoints where the path failed and `error` is a short,
 * human-readable reason. These are deliberately **non-sensitive**: no secrets/tokens, no
 * client IP, no install ID, no report content — only pipeline stage, HTTP status, and
 * category reasons (e.g. a Turnstile code or GitHub's own status message).
 */
function fail(status: number, stage: string, error: string): Response {
  return json(status, { stage, error });
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
  try {
    // 0. Configuration — report *which* binding/secret is missing, never its value.
    const kv = env.REPORT_KV as KVNamespace | undefined;
    const missing: string[] = [];
    if (!env.TURNSTILE_SECRET) missing.push("TURNSTILE_SECRET");
    if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
    if (kv === undefined || typeof kv.get !== "function") missing.push("REPORT_KV");
    if (missing.length > 0) {
      return fail(500, "config", `server not configured: missing ${missing.join(", ")}`);
    }

    // 1. Size cap — reject an oversized body by its declared length before reading it
    //    into memory, then re-check the actual length (a missing/lying header can't slip
    //    past the second check).
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return fail(413, "size", "payload too large");
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, "size", "payload too large");

    // 2. Parse.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail(400, "parse", "invalid JSON body");
    }

    // 3. Validate shape.
    const validation = validateSubmission(parsed);
    if (!validation.ok) return fail(400, "validate", validation.error);
    const { report, turnstileToken } = validation.submission;

    // 4. Turnstile — the primary human-proof gate. Codes are non-sensitive categories.
    const clientIp = request.headers.get("CF-Connecting-IP");
    const verdict = await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, clientIp);
    if (!verdict.ok) {
      return json(403, {
        stage: "turnstile",
        error: "verification failed",
        codes: verdict.codes,
      });
    }

    // 5. Rate-limit on a hashed IP and on the install ID (neither is echoed back).
    const ipKey = rateLimitKey("ip", await hashIp(clientIp ?? "unknown"));
    if (!(await withinLimit(env.REPORT_KV, ipKey, IP_LIMIT))) {
      return fail(429, "ratelimit-ip", "too many reports from this network; try later");
    }
    if (!(await withinLimit(env.REPORT_KV, rateLimitKey("id", report.installId), ID_LIMIT))) {
      return fail(429, "ratelimit-id", "too many reports from this app; try later");
    }

    // 6. Create the GitHub issue. Surface only GitHub's status + its own message.
    const repo = env.GITHUB_REPO ?? DEFAULT_REPO;
    const created = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "inboxclinic-feedback",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(issueFromReport(report)),
    });
    if (!created.ok) {
      const body = (await created.json().catch(() => ({}))) as { message?: string };
      const reason = typeof body.message === "string" ? body.message : "unknown error";
      return fail(502, "github", `GitHub API ${created.status}: ${reason}`);
    }

    const data = (await created.json()) as { html_url?: string };
    return json(200, { stage: "ok", ref: data.html_url ?? "" });
  } catch (error) {
    // 7. Last-resort: an unexpected runtime error. Message only — never a stack or secret.
    const message = error instanceof Error ? error.message : "unexpected error";
    return fail(500, "exception", message.slice(0, 200));
  }
}
