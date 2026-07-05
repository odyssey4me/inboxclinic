// SPDX-License-Identifier: Apache-2.0
/**
 * Reporting client port + payload (architecture.md §6 "Reporting client";
 * design-error-reporting.md Interfaces). One-way submission of an opt-in, redacted
 * diagnostic report. The concrete adapter (e.g. a Cloudflare edge client) is a design
 * choice; the core stays cloud-neutral.
 */

/** A redacted, user-reviewed diagnostic report (client → intake). */
export interface DiagnosticReport {
  /** Redacted error message. */
  message: string;
  /** Redacted stack trace, if any. */
  stack?: string;
  /** Build commit SHA (short) the report was produced on. */
  appVersion: string;
  /** ISO build date. */
  builtAt: string;
  /** App view/action when captured. */
  view?: string;
  /** Browser user-agent string. */
  userAgent?: string;
  /** Navigator online state at capture. */
  online?: boolean;
  /** Anonymous install ID (kept server-side; never written to a public issue). */
  installId: string;
  /** Optional free text the user adds. */
  note?: string;
}

/** Result of a successful submission. */
export interface ReportSubmitResult {
  /** An opaque reference the intake returns (e.g. an issue number/url). */
  ref: string;
}

/** One-way submission port. `humanToken` is an anti-abuse proof (e.g. a Turnstile token). */
export interface ReportingClient {
  submit(report: DiagnosticReport, humanToken: string): Promise<ReportSubmitResult>;
}
