/**
 * In-memory, fixture-backed `GmailClient` for tests.
 *
 * See docs/design-testing.md (Decision 3: mock Google at the `GmailClient` port).
 * Nothing reaches the network. Seed it with `MessageMeta[]` and it serves ids and
 * per-message metadata exactly as the browser adapter would, minus the transport.
 */

import type { AccessToken, GmailClient, MessageMeta } from "../ports/GmailClient";
import { GMAIL_READONLY_SCOPE } from "../ports/GmailClient";

export class MockGmailClient implements GmailClient {
  private messages: MessageMeta[];
  private accountEmail: string;
  /** Records the queries passed to `listMessageIds`, for assertions. */
  readonly listQueries: string[] = [];

  constructor(messages: MessageMeta[] = [], accountEmail = "user@example.com") {
    this.messages = [...messages];
    this.accountEmail = accountEmail;
  }

  /** Replace the seeded inbox. */
  seedInbox(messages: MessageMeta[]): void {
    this.messages = [...messages];
  }

  authenticate(): Promise<AccessToken> {
    return Promise.resolve({
      value: "mock-token",
      expiresAt: Date.now() + 3_600_000,
      grantedScopes: [GMAIL_READONLY_SCOPE],
    });
  }

  getAccessToken(): Promise<AccessToken> {
    return this.authenticate();
  }

  getAccountEmail(): Promise<string> {
    return Promise.resolve(this.accountEmail);
  }

  listMessageIds(query: string, max: number): Promise<string[]> {
    this.listQueries.push(query);
    return Promise.resolve(this.messages.slice(0, max).map((m) => m.id));
  }

  getMessageMeta(id: string): Promise<MessageMeta> {
    const found = this.messages.find((m) => m.id === id);
    if (found === undefined) {
      return Promise.reject(new Error(`MockGmailClient: no message with id ${id}`));
    }
    return Promise.resolve(found);
  }
}
