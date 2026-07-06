// SPDX-License-Identifier: Apache-2.0
import type { DiagnosticReport } from "@inboxclinic/core";
import { describe, expect, it } from "vitest";

import { clientRef, issueFromReport, rateLimitKey, validateSubmission } from "./reportIntake";

const report: DiagnosticReport = {
  message: "Gmail API responded 429",
  appVersion: "abc1234",
  builtAt: "2026-07-05T00:00:00.000Z",
  installId: "11111111-2222-3333-4444-555555555555",
};

describe("clientRef", () => {
  it("is stable for the same id and differs across ids", () => {
    expect(clientRef(report.installId)).toBe(clientRef(report.installId));
    expect(clientRef("a")).not.toBe(clientRef("b"));
    expect(clientRef(report.installId)).toMatch(/^client:[0-9a-z]{1,7}$/);
  });

  it("does not reveal the raw id", () => {
    expect(clientRef(report.installId)).not.toContain(report.installId);
  });
});

describe("validateSubmission", () => {
  it("accepts a well-formed submission", () => {
    const result = validateSubmission({ report, turnstileToken: "tok" });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing token, report, or required field", () => {
    expect(validateSubmission({ report }).ok).toBe(false);
    expect(validateSubmission({ turnstileToken: "tok" }).ok).toBe(false);
    expect(validateSubmission({ report: { message: "x" }, turnstileToken: "tok" }).ok).toBe(false);
    expect(validateSubmission(null).ok).toBe(false);
  });
});

describe("issueFromReport", () => {
  it("builds a titled issue with only the static feedback label; ref in body, never the raw id", () => {
    const issue = issueFromReport(report);
    expect(issue.title).toBe("Report: Gmail API responded 429");
    // Only the pre-existing static label — no unbounded per-install labels.
    expect(issue.labels).toEqual(["feedback"]);
    // The correlation ref lives in the body, not a label.
    expect(issue.body).toContain(clientRef(report.installId));
    expect(issue.body).not.toContain(report.installId);
    expect(issue.title).not.toContain(report.installId);
  });

  it("caps the title length", () => {
    const long = issueFromReport({ ...report, message: "x".repeat(400) });
    expect(long.title.length).toBeLessThanOrEqual(120);
  });
});

describe("rateLimitKey", () => {
  it("namespaces by kind", () => {
    expect(rateLimitKey("ip", "abc")).toBe("rl:ip:abc");
    expect(rateLimitKey("id", "abc")).toBe("rl:id:abc");
  });
});
