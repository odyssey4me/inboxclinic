// SPDX-License-Identifier: Apache-2.0
/**
 * Assemble the human-readable diagnostic report body (design-error-reporting.md Phase 4).
 * Pure: given a `DiagnosticReport`, produce the exact markdown the user reviews and that is
 * copied / downloaded / posted. The **install ID is intentionally excluded** — it is sent
 * as a separate field and kept server-side, never published to a public issue.
 */

import type { DiagnosticReport } from "@inboxclinic/core";

/** Render the published portion of a report as markdown (no install ID). */
export function reportMarkdown(report: DiagnosticReport): string {
  const lines: string[] = [`**Summary:** ${report.message.trim() || "(no message)"}`];

  const note = report.note?.trim();
  if (note !== undefined && note !== "") lines.push("", note);

  lines.push("", `**App:** \`${report.appVersion}\` (built ${report.builtAt})`);

  const env = [
    report.userAgent,
    report.online === undefined ? undefined : report.online ? "online" : "offline",
  ]
    .filter((v): v is string => v !== undefined && v !== "")
    .join(" · ");
  if (env !== "") lines.push(`**Environment:** ${env}`);

  if (report.view !== undefined && report.view !== "") lines.push(`**Where:** ${report.view}`);

  const stack = report.stack?.trim();
  if (stack !== undefined && stack !== "") lines.push("", "```", stack, "```");

  return lines.join("\n");
}
