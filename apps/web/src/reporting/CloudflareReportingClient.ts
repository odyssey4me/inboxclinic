// SPDX-License-Identifier: Apache-2.0
/**
 * `ReportingClient` adapter that POSTs a diagnostic report to the Cloudflare edge intake
 * (`/api/report`), which turns it into an anonymous GitHub issue (design-error-reporting.md
 * Decision 2 / Phase 5). The `humanToken` is a Cloudflare Turnstile token. Same-origin, so
 * no CORS. This adapter is only wired when a Turnstile site key is configured; otherwise the
 * report panel falls back to copy/download (no backend).
 */

import type { DiagnosticReport, ReportingClient, ReportSubmitResult } from "@inboxclinic/core";

export class CloudflareReportingClient implements ReportingClient {
  constructor(private readonly endpoint: string = "/api/report") {}

  async submit(report: DiagnosticReport, humanToken: string): Promise<ReportSubmitResult> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report, turnstileToken: humanToken }),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as {
          stage?: string;
          error?: string;
          codes?: string[];
        };
        const parts: string[] = [];
        if (body.stage !== undefined) parts.push(`[${body.stage}]`);
        if (body.error !== undefined) parts.push(body.error);
        if (body.codes !== undefined && body.codes.length > 0) parts.push(body.codes.join(", "));
        if (parts.length > 0) detail = ` ${parts.join(" ")}`;
      } catch {
        /* non-JSON body — status alone */
      }
      throw new Error(`Report submission failed (${response.status})${detail}`);
    }
    const data = (await response.json()) as { ref?: string };
    return { ref: data.ref ?? "" };
  }
}
