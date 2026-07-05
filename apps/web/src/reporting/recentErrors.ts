// SPDX-License-Identifier: Apache-2.0
/**
 * A small in-memory ring buffer of recently-seen errors (design-error-reporting.md Phase 3).
 * Both caught runtime errors (e.g. a Gmail 429 during sync — App.tsx catch blocks) and
 * render crashes (ErrorBoundary) are recorded here so the "Report a problem" panel can offer
 * them after the fact instead of losing them with the session. In-memory only — never
 * persisted (it may contain unredacted strings until the reporter redacts them).
 */

export interface CapturedError {
  /** Raw error message (redaction happens when a report is built). */
  message: string;
  stack?: string;
  /** App view/action at capture, if known. */
  view?: string;
  /** Epoch ms. */
  at: number;
}

const MAX_ENTRIES = 20;
const buffer: CapturedError[] = [];

/** Record an error (newest first), capped at {@link MAX_ENTRIES}. */
export function recordError(error: unknown, context: { view?: string } = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const entry: CapturedError = { message: err.message, at: Date.now() };
  if (err.stack !== undefined) entry.stack = err.stack;
  if (context.view !== undefined) entry.view = context.view;
  buffer.unshift(entry);
  if (buffer.length > MAX_ENTRIES) buffer.length = MAX_ENTRIES;
}

/** Recent errors, newest first. */
export function getRecentErrors(): readonly CapturedError[] {
  return buffer;
}

/** The most recent error, or `undefined` if none. */
export function latestError(): CapturedError | undefined {
  return buffer[0];
}

/** Clear the buffer (e.g. after a successful report, or in tests). */
export function clearRecentErrors(): void {
  buffer.length = 0;
}
