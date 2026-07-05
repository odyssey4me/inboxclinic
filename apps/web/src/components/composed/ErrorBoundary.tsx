// SPDX-License-Identifier: Apache-2.0
import { redact } from "@inboxclinic/core";
import { Component, type ReactNode } from "react";

import { recordError } from "../../reporting/recentErrors";
import { Button } from "../ui/Button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level React error boundary. A render crash is recorded to the recent-errors buffer
 * (design-error-reporting.md) and a calm recovery screen is shown with a redacted message
 * and a "Try again". Phase 4 adds a "Report a problem" action here.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    recordError(error, { view: "render" });
  }

  private reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
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
        <div className="flex gap-2">
          <Button onClick={this.reset}>Try again</Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
