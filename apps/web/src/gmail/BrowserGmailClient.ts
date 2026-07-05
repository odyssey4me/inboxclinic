// SPDX-License-Identifier: Apache-2.0
/**
 * Browser `GmailClient` adapter — GIS token flow + Gmail REST (metadata only).
 *
 * See docs/design-gmail-integration.md (Decisions 1 & 3): a public PKCE client via
 * Google Identity Services, an **in-memory** access token (never persisted, no
 * refresh token, no secret), and `messages.get?format=metadata` reads — never bodies.
 * Implements the `GmailClient` port from `@inboxclinic/core`.
 */

import { SCOPES_BY_TIER, StaleHistoryError } from "@inboxclinic/core";
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
  ScopeTier,
} from "@inboxclinic/core";

import { requestAccessToken } from "../auth/gis";
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
  criteria?: { from?: string };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] };
}

interface GmailFilterListResponse {
  filter?: GmailFilterResource[];
}

/** Map a Gmail filter resource into the port's `NativeFilter` shape. */
function toNativeFilter(resource: GmailFilterResource): NativeFilter {
  return {
    id: resource.id,
    from: resource.criteria?.from ?? "",
    addLabelIds: resource.action?.addLabelIds ?? [],
    removeLabelIds: resource.action?.removeLabelIds ?? [],
  };
}

function parseHeaders(headers: GmailHeader[]): MessageHeaders {
  const result: MessageHeaders = {};
  for (const { name, value } of headers) {
    const key = HEADER_KEYS[name.toLowerCase()];
    if (key !== undefined) result[key] = value;
  }
  return result;
}

export class BrowserGmailClient implements GmailClient {
  private token: AccessToken | null = null;

  constructor(private readonly clientId: string) {}

  /**
   * Acquire a token for the requested scope tiers (design-gmail-integration.md
   * Decision 2, incremental authorisation). Tier 1 (read-only) is always included so
   * escalating to Tier 2 (enforcement) never drops scan access.
   */
  async authenticate(tiers: ScopeTier[] = [1]): Promise<AccessToken> {
    if (this.clientId === "") {
      throw new Error("VITE_OAUTH_CLIENT_ID is not configured");
    }
    const scopes = scopesForTiers(tiers);
    const response = await requestAccessToken(this.clientId, scopes.join(" "));

    this.token = {
      value: response.access_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      grantedScopes: response.scope.split(" "),
    };
    return this.token;
  }

  async getAccessToken(): Promise<AccessToken> {
    if (this.token === null || this.token.expiresAt <= Date.now()) {
      return this.authenticate();
    }
    return this.token;
  }

  /**
   * Return a token that covers the given tiers, escalating via incremental
   * authorisation if the current token is missing the scopes (e.g. the first time an
   * enforcement action runs). Tier 1 is always re-requested alongside so read access
   * is retained.
   */
  private async ensureScopes(tiers: ScopeTier[]): Promise<AccessToken> {
    const required = scopesForTiers(tiers);
    const token = await this.getAccessToken();
    if (required.every((scope) => token.grantedScopes.includes(scope))) {
      return token;
    }
    return this.authenticate([1, ...tiers]);
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

  // --- Incremental sync (Tier 1) --------------------------------------------

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

  // --- Enforcement (Tier 2) -------------------------------------------------

  async listFilters(): Promise<NativeFilter[]> {
    await this.ensureScopes([2]);
    const response = await this.apiGet<GmailFilterListResponse>("/settings/filters");
    return (response.filter ?? []).map(toNativeFilter);
  }

  async createFilter(spec: FilterSpec): Promise<NativeFilter> {
    await this.ensureScopes([2]);
    const body = {
      criteria: { from: spec.from },
      action: { addLabelIds: spec.addLabelIds, removeLabelIds: spec.removeLabelIds },
    };
    const created = await this.apiSend<GmailFilterResource>("POST", "/settings/filters", body);
    return toNativeFilter(created);
  }

  async deleteFilter(id: string): Promise<void> {
    await this.ensureScopes([2]);
    await this.apiSend("DELETE", `/settings/filters/${id}`);
  }

  async batchModifyMessages(ids: string[], edit: MessageLabelEdit): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureScopes([2]);
    for (let i = 0; i < ids.length; i += BATCH_MODIFY_LIMIT) {
      const batch = ids.slice(i, i + BATCH_MODIFY_LIMIT);
      await this.apiSend("POST", "/messages/batchModify", {
        ids: batch,
        addLabelIds: edit.addLabelIds ?? [],
        removeLabelIds: edit.removeLabelIds ?? [],
      });
    }
  }

  async listMessageIdsForSender(from: string, max = PAGE_SIZE): Promise<string[]> {
    return this.listMessageIds(`from:${from}`, max);
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

/** Union of the least-permission scopes for the requested tiers (deduplicated). */
function scopesForTiers(tiers: ScopeTier[]): string[] {
  return [...new Set(tiers.flatMap((tier) => SCOPES_BY_TIER[tier]))];
}
