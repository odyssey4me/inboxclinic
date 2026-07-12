// SPDX-License-Identifier: Apache-2.0
import type { EnforceResult } from "@inboxclinic/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EnforcementSummary } from "./TrustWorkflow";

/** A clean no-op result: nothing changed, nothing failed. */
function baseResult(overrides: Partial<EnforceResult> = {}): EnforceResult {
  return {
    filtersCreated: 0,
    filtersDeleted: 0,
    messagesArchived: 0,
    messagesTrashed: 0,
    messagesRescued: 0,
    unsubscribeRequested: 0,
    totalFilters: 0,
    capReached: false,
    skippedAtCap: 0,
    failures: [],
    ...overrides,
  };
}

describe("EnforcementSummary", () => {
  it("reports a genuine no-op when nothing changed and nothing failed", () => {
    render(<EnforcementSummary result={baseResult()} />);
    expect(screen.getByText("No Gmail changes were needed.")).toBeInTheDocument();
    expect(screen.queryByText(/action\(s\) failed/)).not.toBeInTheDocument();
  });

  it("summarises the changes that were applied", () => {
    render(<EnforcementSummary result={baseResult({ filtersCreated: 2, messagesArchived: 5 })} />);
    expect(screen.getByText("2 filter(s) created · 5 archived.")).toBeInTheDocument();
  });

  it("does NOT claim nothing was needed when an action failed (issue #12)", () => {
    render(
      <EnforcementSummary
        result={baseResult({ failures: [{ subject: "filters", error: "network error" }] })}
      />,
    );
    // The misleading "nothing to do" copy must not appear alongside a failure…
    expect(screen.queryByText("No Gmail changes were needed.")).not.toBeInTheDocument();
    // …instead we say nothing completed, and surface the actual reason.
    expect(screen.getByText("No changes completed.")).toBeInTheDocument();
    expect(screen.getByText("1 action(s) failed; will retry on sync.")).toBeInTheDocument();
    expect(screen.getByText("network error")).toBeInTheDocument();
  });

  it("collapses repeated failure reasons into distinct lines", () => {
    render(
      <EnforcementSummary
        result={baseResult({
          failures: [
            { subject: "a", error: "network error" },
            { subject: "b", error: "network error" },
            { subject: "c", error: "quota exceeded" },
          ],
        })}
      />,
    );
    expect(screen.getByText("3 action(s) failed; will retry on sync.")).toBeInTheDocument();
    expect(screen.getAllByText("network error")).toHaveLength(1);
    expect(screen.getByText("quota exceeded")).toBeInTheDocument();
  });
});
