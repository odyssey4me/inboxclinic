// SPDX-License-Identifier: Apache-2.0
/**
 * Pure helpers for the feedback edge intake (design-error-reporting.md Decision 6 / Phase 5).
 * Kept here under `src/` so they are unit-testable; the Cloudflare Pages Function
 * (`functions/api/report.ts`) imports them. No I/O — validation, the GitHub-issue shape, and
 * a non-reversible correlation label. The raw install ID and client IP never appear in the
 * issue produced here.
 */

import type { DiagnosticReport } from "@inboxclinic/core";

import { reportMarkdown } from "./report";

/** Reject payloads larger than this (bytes) before doing any work. */
export const MAX_BODY_BYTES = 16_384;

/** The request body the client POSTs. */
export interface ReportSubmission {
  report: DiagnosticReport;
  turnstileToken: string;
}

/** A validated GitHub issue shape (no install ID, no IP). */
export interface IssueSpec {
  title: string;
  body: string;
  labels: string[];
}

/**
 * A short, non-reversible correlation ref for an install ID (FNV-1a → base36). Not
 * cryptographic — it only groups an honest reporter's issues without publishing the raw ID.
 * Placed in the issue body (not a label) so per-reporter refs don't explode the label list.
 */
export function clientRef(installId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < installId.length; i++) {
    hash ^= installId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `client:${(hash >>> 0).toString(36).padStart(7, "0").slice(0, 7)}`;
}

/** Validate a parsed submission. Returns the report, or an error message. */
export function validateSubmission(
  value: unknown,
): { ok: true; submission: ReportSubmission } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "malformed body" };
  const { report, turnstileToken } = value as Record<string, unknown>;
  if (typeof turnstileToken !== "string" || turnstileToken === "") {
    return { ok: false, error: "missing turnstile token" };
  }
  if (typeof report !== "object" || report === null) return { ok: false, error: "missing report" };
  const r = report as Record<string, unknown>;
  for (const field of ["message", "appVersion", "builtAt", "installId"] as const) {
    if (typeof r[field] !== "string" || (r[field] as string) === "") {
      return { ok: false, error: `missing ${field}` };
    }
  }
  return { ok: true, submission: { report: r as unknown as DiagnosticReport, turnstileToken } };
}

/**
 * Build the GitHub issue from a validated report — never includes the raw install ID or IP.
 * Uses only the static `feedback` label (created out-of-band); the per-install correlation
 * ref lives in the body so unique reporters don't create unbounded labels.
 */
export function issueFromReport(report: DiagnosticReport): IssueSpec {
  const firstLine = report.message.trim().split("\n")[0] ?? "";
  const title = `Report: ${firstLine}`.slice(0, 120).trim() || "Report: (no message)";
  const body = `${reportMarkdown(report)}\n\n---\nref: \`${clientRef(report.installId)}\``;
  return { title, body, labels: ["feedback"] };
}

/** KV key for a rate-limit bucket (namespaced by kind so IP and install-ID buckets differ). */
export function rateLimitKey(kind: "ip" | "id", value: string): string {
  return `rl:${kind}:${value}`;
}
