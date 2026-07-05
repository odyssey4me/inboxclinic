// SPDX-License-Identifier: Apache-2.0
import { redact, type Store } from "@inboxclinic/core";
import { Component, type ReactNode } from "react";

import { recordError } from "../../reporting/recentErrors";
import { Button } from "../ui/Button";
import { ReportProblem } from "./ReportProblem";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** When provided, the recovery screen offers a "Report a problem" panel. */
  store?: Store;
}

interface ErrorBoundaryState {
  error: Error | null;
  reporting: boolean;
}

/**
 * Top-level React error boundary. A render crash is recorded to the recent-errors buffer
 * (design-error-reporting.md) and a calm recovery screen is shown with a redacted message,
 * a "Try again", and — when a store is available — an opt-in "Report a problem" panel.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, reporting: false };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    recordError(error, { view: "render" });
  }

  private reset = (): void => this.setState({ error: null, reporting: false });

  override render(): ReactNode {
    const { error, reporting } = this.state;
    const { store } = this.props;
    if (error === null) return this.props.children;

    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold text-ink">Something went wrong</h1>
        <p className="text-sm text-muted">
          The app hit an unexpected error. Your on-device data is safe.
        </p>
        <pre className="max-h-40 w-full overflow-auto rounded-md border border-line bg-surface-2 p-3 text-left text-xs text-muted">
          {redact(error.message)}
        </pre>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={this.reset}>Try again</Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload
          </Button>
          {store !== undefined && !reporting && (
            <Button variant="secondary" onClick={() => this.setState({ reporting: true })}>
              Report a problem
            </Button>
          )}
        </div>
        {store !== undefined && reporting && (
          <div className="w-full text-left">
            <ReportProblem
              store={store}
              initial={{
                message: error.message,
                ...(error.stack !== undefined ? { stack: error.stack } : {}),
                view: "render",
              }}
            />
          </div>
        )}
      </div>
    );
  }
}
