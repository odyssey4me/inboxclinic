// SPDX-License-Identifier: Apache-2.0
/**
 * Browser `GmailClient` adapter — GIS token flow + Gmail REST (metadata only).
 *
 * See docs/design-gmail-integration.md (Decisions 1 & 3): a public PKCE client via
 * Google Identity Services, an **in-memory** access token (never persisted, no
 * refresh token, no secret), and `messages.get?format=metadata` reads — never bodies.
 * Implements the `GmailClient` port from `@inboxclinic/core`.
 */

import { StaleHistoryError, unwrapExcludeFrom } from "@inboxclinic/core";
import type {
  AccessToken,
  FilterSpec,
  GmailClient,
  HistoryList,
  HistoryRecord,
  ListHistoryOptions,
  MessageHeaders,
  MessageLabelEdit,
  MessageMeta,
  NativeFilter,
} from "@inboxclinic/core";

import type { GoogleAuth } from "../auth/GoogleAuth";
import { fetchWithRetry } from "../lib/googleFetch";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE = 500;
/** Gmail caps `batchModify` at 1000 ids per call. */
const BATCH_MODIFY_LIMIT = 1000;

/** Metadata headers requested per message (design Decision 3). */
const METADATA_HEADERS = [
  "From",
  "To",
  "Subject",
  "Date",
  "Message-ID",
  "Reply-To",
  "List-Unsubscribe",
  "List-Id",
  "Authentication-Results",
] as const;

const HEADER_KEYS: Record<string, keyof MessageHeaders> = {
  from: "from",
  to: "to",
  subject: "subject",
  date: "date",
  "message-id": "messageId",
  "reply-to": "replyTo",
  "list-unsubscribe": "listUnsubscribe",
  "list-id": "listId",
  "authentication-results": "authenticationResults",
};

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessageListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
}

interface GmailMessageResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}

interface GmailProfileResponse {
  emailAddress: string;
  historyId?: string;
}

interface GmailHistoryListResponse {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

interface GmailFilterResource {
  id: string;
  // Indexed, not a closed shape: Gmail supports criteria this port does not model, and
  // knowing WHICH are present is what stops us mistaking one rule for another (#212).
  criteria?: { from?: string; negatedQuery?: string } & Record<string, unknown>;
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] };
}

/** The `criteria` fields `FilterSpec` represents; anything else makes a filter foreign. */
const MODELLED_CRITERIA = new Set(["from", "negatedQuery"]);

interface GmailFilterListResponse {
  filter?: GmailFilterResource[];
}

/**
 * Whether a criteria field actually constrains matching. A field present but empty, `false`,
 * or null narrows nothing — Gmail's JSON normally omits defaults, but an echoed one must not
 * make a filter look foreign, because then every managed filter would disown itself and
 * reconcile would recreate the entire managed set on every sync.
 */
function constrainsMatching(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  return !(Array.isArray(value) && value.length === 0);
}

/** Map a Gmail filter resource into the port's `NativeFilter` shape. Exported for testing. */
export function toNativeFilter(resource: GmailFilterResource): NativeFilter {
  const excludeFrom = unwrapExcludeFrom(resource.criteria?.negatedQuery);
  // Report the criteria we drop, rather than silently projecting them away: a filter also
  // matching on `subject`/`to`/`query` signs identically to a plain block, so downstream
  // code needs to know its own view is partial before it treats the two as one rule (#212).
  const unmodelledCriteria = Object.entries(resource.criteria ?? {})
    .filter(([field, value]) => !MODELLED_CRITERIA.has(field) && constrainsMatching(value))
    .map(([field]) => field)
    .sort();
  return {
    id: resource.id,
    from: resource.criteria?.from ?? "",
    // Read the exclusion back so reconcile is idempotent — a filter with exceptions must
    // compare equal to its desired spec, not look "missing exclusion" every run (#145).
    ...(excludeFrom !== undefined ? { excludeFrom } : {}),
    ...(unmodelledCriteria.length > 0 ? { unmodelledCriteria } : {}),
    addLabelIds: resource.action?.addLabelIds ?? [],
    removeLabelIds: resource.action?.removeLabelIds ?? [],
  };
}

/**
 * Map a raw Gmail header array to the metadata-only `MessageHeaders` we keep. The array comes
 * from unchecked `JSON.parse` of the API response, so tolerate malformed entries (missing /
 * non-string `name`/`value`) rather than throwing — and, by construction, only ever copy the
 * allowlisted header names in `HEADER_KEYS`, never a message body (privacy). Exported for fuzzing.
 */
export function parseHeaders(headers: readonly GmailHeader[]): MessageHeaders {
  const result: MessageHeaders = {};
  if (!Array.isArray(headers)) return result;
  for (const entry of headers) {
    if (entry === null || typeof entry !== "object") continue;
    const { name, value } = entry as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || typeof value !== "string") continue;
    // `Object.hasOwn` so a header literally named `__proto__`/`constructor`/`toString` resolves
    // to `undefined` (its own key) rather than an inherited prototype member.
    const lower = name.toLowerCase();
    const key = Object.hasOwn(HEADER_KEYS, lower) ? HEADER_KEYS[lower] : undefined;
    if (key !== undefined) result[key] = value;
  }
  return result;
}

export class BrowserGmailClient implements GmailClient {
  constructor(private readonly auth: GoogleAuth) {}

  /**
   * Take the single sign-in grant (design-gmail-integration.md Decision 2). There is no
   * per-capability variant: enforcement calls below use the same token as the scan.
   */
  async authenticate(): Promise<AccessToken> {
    return this.auth.authenticate();
  }

  async getAccessToken(): Promise<AccessToken> {
    return this.auth.getAccessToken();
  }

  async getAccountEmail(): Promise<string> {
    const profile = await this.apiGet<GmailProfileResponse>("/profile");
    return profile.emailAddress;
  }

  async listMessageIds(query: string, max: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(max - ids.length, PAGE_SIZE)),
      });
      if (pageToken !== undefined) params.set("pageToken", pageToken);
      const page = await this.apiGet<GmailMessageListResponse>(`/messages?${params.toString()}`);
      for (const message of page.messages ?? []) {
        ids.push(message.id);
        if (ids.length >= max) return ids;
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined && ids.length < max);
    return ids;
  }

  async getMessageMeta(id: string): Promise<MessageMeta> {
    const params = new URLSearchParams({ format: "metadata" });
    for (const header of METADATA_HEADERS) params.append("metadataHeaders", header);
    const message = await this.apiGet<GmailMessageResponse>(`/messages/${id}?${params.toString()}`);
    return {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds ?? [],
      internalDate: message.internalDate !== undefined ? Number(message.internalDate) : 0,
      headers: parseHeaders(message.payload?.headers ?? []),
    };
  }

  // --- Incremental sync --------------------------------------------

  async getLatestHistoryId(): Promise<string> {
    const profile = await this.apiGet<GmailProfileResponse>("/profile");
    return profile.historyId ?? "";
  }

  /**
   * Page through `users.history.list` since `startHistoryId`. A 404 means Gmail no
   * longer retains history that far back; surface it as {@link StaleHistoryError} so the
   * caller runs a bounded rescan (design-gmail-integration.md Decision 4).
   */
  async listHistory(
    startHistoryId: string,
    options: ListHistoryOptions = {},
  ): Promise<HistoryList> {
    const records: HistoryRecord[] = [];
    let latestHistoryId = startHistoryId;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ startHistoryId });
      if (options.labelId !== undefined) params.set("labelId", options.labelId);
      if (pageToken !== undefined) params.set("pageToken", pageToken);

      const token = await this.getAccessToken();
      const response = await fetchWithRetry(`${GMAIL_API}/history?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token.value}` },
      });
      if (response.status === 404) {
        throw new StaleHistoryError();
      }
      if (!response.ok) {
        throw new Error(`Gmail API responded ${response.status} for /history`);
      }
      const page = (await response.json()) as GmailHistoryListResponse;
      records.push(...(page.history ?? []));
      if (page.historyId !== undefined) latestHistoryId = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);

    return { records, historyId: latestHistoryId };
  }

  // --- Enforcement -------------------------------------------------

  async listFilters(): Promise<NativeFilter[]> {
    const response = await this.apiGet<GmailFilterListResponse>("/settings/filters");
    return (response.filter ?? []).map(toNativeFilter);
  }

  async createFilter(spec: FilterSpec): Promise<NativeFilter> {
    const criteria: { from: string; negatedQuery?: string } = { from: spec.from };
    // Carve out trusted exception addresses via Gmail's "doesn't have the words" (#145).
    if (spec.excludeFrom !== undefined && spec.excludeFrom !== "") {
      criteria.negatedQuery = `from:(${spec.excludeFrom})`;
    }
    const body = {
      criteria,
      action: { addLabelIds: spec.addLabelIds, removeLabelIds: spec.removeLabelIds },
    };
    const created = await this.apiSend<GmailFilterResource>("POST", "/settings/filters", body);
    return toNativeFilter(created);
  }

  async deleteFilter(id: string): Promise<void> {
    await this.apiSend("DELETE", `/settings/filters/${id}`);
  }

  async batchModifyMessages(ids: string[], edit: MessageLabelEdit): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += BATCH_MODIFY_LIMIT) {
      const batch = ids.slice(i, i + BATCH_MODIFY_LIMIT);
      await this.apiSend("POST", "/messages/batchModify", {
        ids: batch,
        addLabelIds: edit.addLabelIds ?? [],
        removeLabelIds: edit.removeLabelIds ?? [],
      });
    }
  }

  async listMessageIdsForSender(
    from: string,
    max = PAGE_SIZE,
    excludeFrom?: string,
  ): Promise<string[]> {
    const query =
      excludeFrom !== undefined && excludeFrom !== ""
        ? `from:${from} -from:(${excludeFrom})`
        : `from:${from}`;
    return this.listMessageIds(query, max);
  }

  private async apiGet<T>(path: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetchWithRetry(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${token.value}` },
    });
    if (!response.ok) {
      throw new Error(`Gmail API responded ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }

  /** POST/DELETE helper; returns the parsed body (or `undefined` for empty responses). */
  private async apiSend<T>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetchWithRetry(`${GMAIL_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.value}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`Gmail API responded ${response.status} for ${method} ${path}`);
    }
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }
}
