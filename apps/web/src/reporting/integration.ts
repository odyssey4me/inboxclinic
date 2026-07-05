// SPDX-License-Identifier: Apache-2.0
/**
 * Wires the feedback submit path when — and only when — a Turnstile site key is configured
 * (design-error-reporting.md Phase 5). With no key, this returns `undefined` and the report
 * panel falls back to copy/download (no backend). Build-time flag, so a module-level lookup
 * is fine.
 */

import type { ReportingClient } from "@inboxclinic/core";

import { CloudflareReportingClient } from "./CloudflareReportingClient";
import { requestTurnstileToken } from "./turnstile";

export interface ReportingIntegration {
  client: ReportingClient;
  getHumanToken: () => Promise<string>;
}

/** The submit integration, or `undefined` when feedback submission is not configured. */
export function reportingIntegration(): ReportingIntegration | undefined {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  if (siteKey === undefined || siteKey === "") return undefined;
  return {
    client: new CloudflareReportingClient(),
    getHumanToken: () => requestTurnstileToken(siteKey),
  };
}
