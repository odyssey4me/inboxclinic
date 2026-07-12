// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearRecentErrors, latestError } from "../../reporting/recentErrors";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("kaboom for news@retailco.com");
}

afterEach(() => {
  clearRecentErrors();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("catches a render crash, records it, and shows a redacted recovery screen", () => {
    // React logs the caught error to console.error — silence it for a clean run.
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    // The displayed message is redacted (the email is masked).
    expect(screen.getByText(/kaboom for \[email\]/)).toBeInTheDocument();
    // And it was captured to the recent-errors buffer for later reporting.
    expect(latestError()?.message).toBe("kaboom for news@retailco.com");
  });
});
