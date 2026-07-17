// SPDX-License-Identifier: Apache-2.0
/**
 * Fixture builders for entities and message metadata.
 *
 * Pure factories that produce typed `MessageMeta` / `Sender` / `Domain` fixtures; they
 * never touch the network or a real store. Used by the **demo** fixtures
 * (`@inboxclinic/core/demo`) and re-exported to the **tests**
 * (`@inboxclinic/core/testing`).
 */

import { keyFor } from "../keys";
import type { MessageHeaders, MessageMeta } from "../ports/GmailClient";
import type { Domain, Sender } from "../store/types";

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

/**
 * Build a fully-populated `Sender` with sensible defaults (used by enforcement tests
 * that need stored entities directly rather than via a scan). `email` derives the id,
 * domain, and display defaults; pass overrides to set trust status / pending actions.
 */
export function senderBuilder(email: string, overrides: Partial<Sender> = {}): Sender {
  const domain = email.split("@")[1] ?? "example.com";
  return {
    id: keyFor(email),
    email,
    domain,
    displayName: null,
    category: "other",
    trustStatus: "pending",
    totalEmails: 1,
    hasListUnsubscribe: false,
    hasListId: false,
    firstSeenAt: 0,
    lastSeenAt: 0,
    updatedAt: 0,
    readRate: null,
    starredCount: 0,
    spamMarkedCount: 0,
    deletedUnreadCount: 0,
    coveredByBlockFilter: false,
    replyCount: 0,
    inContacts: false,
    frequency: "rare",
    recencyBuckets: { d30: 0, d90: 0, d180: 0, older: 0 },
    auth: { spf: false, dkim: false, dmarc: false, spoofed: false },
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
    ...overrides,
  };
}

/** Build a fully-populated `Domain` with sensible defaults. */
export function domainBuilder(domain: string, overrides: Partial<Domain> = {}): Domain {
  return {
    id: keyFor(domain),
    domain,
    trustStatus: "pending",
    senderCount: 1,
    totalEmails: 1,
    exceptionAddresses: [],
    updatedAt: 0,
    trustDecidedAt: null,
    decisionScope: null,
    decisionContext: null,
    pendingActions: [],
    ...overrides,
  };
}
