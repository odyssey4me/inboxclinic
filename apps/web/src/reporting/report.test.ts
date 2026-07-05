// SPDX-License-Identifier: Apache-2.0
import type { DiagnosticReport } from "@inboxclinic/core";
import { describe, expect, it } from "vitest";

import { reportMarkdown } from "./report";

const base: DiagnosticReport = {
  message: "Gmail API responded 429",
  appVersion: "abc1234",
  builtAt: "2026-07-05T00:00:00.000Z",
  installId: "11111111-2222-3333-4444-555555555555",
};

describe("reportMarkdown", () => {
  it("includes the summary and app stamp, and never the install ID", () => {
    const md = reportMarkdown(base);
    expect(md).toContain("**Summary:** Gmail API responded 429");
    expect(md).toContain("**App:** `abc1234` (built 2026-07-05T00:00:00.000Z)");
    expect(md).not.toContain(base.installId);
  });

  it("adds note, environment, view, and a stack code block when present", () => {
    const md = reportMarkdown({
      ...base,
      note: "happened during scan",
      userAgent: "TestBrowser/1.0",
      online: true,
      view: "sync",
      stack: "at foo()\nat bar()",
    });
    expect(md).toContain("happened during scan");
    expect(md).toContain("**Environment:** TestBrowser/1.0 · online");
    expect(md).toContain("**Where:** sync");
    expect(md).toContain("```\nat foo()\nat bar()\n```");
  });

  it("shows offline and a placeholder for an empty message", () => {
    const md = reportMarkdown({ ...base, message: "   ", online: false });
    expect(md).toContain("**Summary:** (no message)");
    expect(md).toContain("offline");
  });
});
