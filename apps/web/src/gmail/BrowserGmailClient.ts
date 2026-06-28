/**
 * Browser `GmailClient` adapter — GIS token flow + Gmail REST (metadata only).
 *
 * See docs/design-gmail-integration.md (Decisions 1 & 3): a public PKCE client via
 * Google Identity Services, an **in-memory** access token (never persisted, no
 * refresh token, no secret), and `messages.get?format=metadata` reads — never bodies.
 * Implements the `GmailClient` port from `@inboxclinic/core`.
 */

import { GMAIL_READONLY_SCOPE } from "@inboxclinic/core";
import type { AccessToken, GmailClient, MessageHeaders, MessageMeta } from "@inboxclinic/core";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GIS_POLL_MS = 50;
const GIS_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 500;

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
}

function waitForGis(): Promise<typeof google.accounts.oauth2> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2 !== undefined) {
        resolve(oauth2);
      } else if (Date.now() - start > GIS_TIMEOUT_MS) {
        reject(new Error("Google Identity Services failed to load"));
      } else {
        setTimeout(poll, GIS_POLL_MS);
      }
    };
    poll();
  });
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

  async authenticate(): Promise<AccessToken> {
    if (this.clientId === "") {
      throw new Error("VITE_OAUTH_CLIENT_ID is not configured");
    }
    const oauth2 = await waitForGis();
    const response = await new Promise<google.accounts.oauth2.TokenResponse>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: this.clientId,
        scope: GMAIL_READONLY_SCOPE,
        callback: (resp) => {
          if (resp.error !== undefined) {
            reject(new Error(resp.error_description ?? resp.error));
          } else {
            resolve(resp);
          }
        },
        error_callback: (err) => reject(new Error(err.message ?? err.type)),
      });
      client.requestAccessToken();
    });

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

  private async apiGet<T>(path: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${token.value}` },
    });
    if (!response.ok) {
      throw new Error(`Gmail API responded ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  }
}
