/**
 * In-memory, fixture-backed `GmailClient` for tests.
 *
 * See docs/design-testing.md (Decision 3: mock Google at the `GmailClient` port).
 * Nothing reaches the network. Seed it with `MessageMeta[]` and it serves ids and
 * per-message metadata exactly as the browser adapter would, minus the transport.
 *
 * The enforcement surface (M4) is modelled with real in-memory state: created filters
 * are retained so `listFilters` reflects them (giving `enforce` genuine idempotency),
 * and filter/batch-modify calls are recorded for assertions.
 */

import type {
  AccessToken,
  FilterSpec,
  GmailClient,
  MessageLabelEdit,
  MessageMeta,
  NativeFilter,
  ScopeTier,
} from "../ports/GmailClient";
import { SCOPES_BY_TIER } from "../ports/GmailClient";

/** A recorded `batchModifyMessages` call. */
export interface BatchModifyCall {
  ids: string[];
  edit: MessageLabelEdit;
}

export class MockGmailClient implements GmailClient {
  private messages: MessageMeta[];
  private accountEmail: string;
  private filters: NativeFilter[] = [];
  private filterSeq = 0;
  /** Records the queries passed to `listMessageIds`, for assertions. */
  readonly listQueries: string[] = [];
  /** Records the `from` clauses passed to `listMessageIdsForSender`, for assertions. */
  readonly senderQueries: string[] = [];
  /** Records created native filters, for assertions. */
  readonly createdFilters: FilterSpec[] = [];
  /** Records deleted native-filter ids, for assertions. */
  readonly deletedFilterIds: string[] = [];
  /** Records `batchModifyMessages` calls, for assertions. */
  readonly batchModifyCalls: BatchModifyCall[] = [];

  constructor(messages: MessageMeta[] = [], accountEmail = "user@example.com") {
    this.messages = [...messages];
    this.accountEmail = accountEmail;
  }

  /** Replace the seeded inbox. */
  seedInbox(messages: MessageMeta[]): void {
    this.messages = [...messages];
  }

  /** Seed pre-existing native filters (e.g. to test reconciliation/idempotency). */
  seedFilters(filters: NativeFilter[]): void {
    this.filters = filters.map((f) => ({ ...f }));
  }

  authenticate(tiers: ScopeTier[] = [1]): Promise<AccessToken> {
    const grantedScopes = [...new Set(tiers.flatMap((tier) => SCOPES_BY_TIER[tier]))];
    return Promise.resolve({
      value: "mock-token",
      expiresAt: Date.now() + 3_600_000,
      grantedScopes,
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

  listFilters(): Promise<NativeFilter[]> {
    return Promise.resolve(this.filters.map((f) => ({ ...f })));
  }

  createFilter(spec: FilterSpec): Promise<NativeFilter> {
    this.createdFilters.push(spec);
    this.filterSeq += 1;
    const created: NativeFilter = { ...spec, id: `filter-${this.filterSeq}` };
    this.filters.push(created);
    return Promise.resolve({ ...created });
  }

  deleteFilter(id: string): Promise<void> {
    this.deletedFilterIds.push(id);
    this.filters = this.filters.filter((f) => f.id !== id);
    return Promise.resolve();
  }

  batchModifyMessages(ids: string[], edit: MessageLabelEdit): Promise<void> {
    this.batchModifyCalls.push({ ids: [...ids], edit });
    return Promise.resolve();
  }

  listMessageIdsForSender(from: string, max = 500): Promise<string[]> {
    this.senderQueries.push(from);
    const matcher = senderMatcher(from);
    return Promise.resolve(
      this.messages
        .filter((m) => matcher(m.headers.from ?? ""))
        .slice(0, max)
        .map((m) => m.id),
    );
  }
}

/** Build a predicate that matches a `From` header against an address or `*@domain`. */
function senderMatcher(from: string): (header: string) => boolean {
  const needle = from.toLowerCase();
  if (needle.startsWith("*@")) {
    const domain = needle.slice(2);
    return (header) => header.toLowerCase().includes(`@${domain}`);
  }
  return (header) => header.toLowerCase().includes(needle);
}
