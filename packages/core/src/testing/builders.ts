/**
 * Fixture builders for tests (core and web).
 *
 * See docs/design-testing.md ("builders.ts"). These produce typed `MessageMeta`
 * fixtures for the metadata scan; they never touch the network or a real store.
 */

import type { MessageHeaders, MessageMeta } from "../ports/GmailClient";

let seq = 0;

export interface MessageMetaOverrides {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: number;
  headers?: Partial<MessageHeaders>;
}

/**
 * Build a metadata-only `MessageMeta` with sensible defaults. Pass `headers.from`
 * (and any other headers/labels) to shape the sender under test.
 */
export function messageMetaBuilder(overrides: MessageMetaOverrides = {}): MessageMeta {
  seq += 1;
  const id = overrides.id ?? `msg-${seq}`;
  const headers: MessageHeaders = {
    from: "Someone <someone@example.com>",
    subject: "Hello",
    date: "Wed, 28 Jun 2026 10:00:00 +0000",
    ...overrides.headers,
  };
  return {
    id,
    threadId: overrides.threadId ?? `thread-${id}`,
    labelIds: overrides.labelIds ?? ["INBOX"],
    internalDate: overrides.internalDate ?? Date.UTC(2026, 5, 28),
    headers,
  };
}

/**
 * Build `count` messages from a single sender (helpful for frequency/volume tests).
 */
export function inboxFromSender(
  from: string,
  count: number,
  overrides: MessageMetaOverrides = {},
): MessageMeta[] {
  return Array.from({ length: count }, () =>
    messageMetaBuilder({
      ...overrides,
      headers: { ...overrides.headers, from },
    }),
  );
}
