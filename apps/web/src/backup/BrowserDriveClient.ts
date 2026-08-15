// SPDX-License-Identifier: Apache-2.0
/**
 * Browser `BackupClient` adapter — Drive REST v3 over the shared sign-in grant.
 *
 * See docs/design-backup-restore.md. Backup to the user's **own** Drive: a single
 * user-visible file (`Inbox Clinic Backup.json`), found-or-created then overwritten in
 * place. `drive.file` is part of the single sign-in grant (Decision 2), so this adapter
 * takes its token from the shared {@link GoogleAuth} rather than running a consent flow
 * of its own. Implements the `BackupClient` port from `@inboxclinic/core`; the store's
 * `exportAll`/`importAll` supply/consume the bytes.
 */

import { BACKUP_FILE_NAME, BackupNotFoundError } from "@inboxclinic/core";
import type { BackupClient, BackupFile } from "@inboxclinic/core";

import type { GoogleAuth } from "../auth/GoogleAuth";
import { fetchWithRetry } from "../lib/googleFetch";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const BACKUP_MIME = "application/json";
/** Fixed multipart boundary; the JSON payload never contains this sentinel. */
const MULTIPART_BOUNDARY = "inboxclinic-backup-boundary";

interface DriveFileResource {
  id: string;
  name: string;
  modifiedTime?: string;
}

interface DriveFileListResponse {
  files?: DriveFileResource[];
}

function toBackupFile(resource: DriveFileResource): BackupFile {
  return {
    id: resource.id,
    name: resource.name,
    modifiedTime: resource.modifiedTime ?? "",
  };
}

export class BrowserDriveClient implements BackupClient {
  constructor(private readonly auth: GoogleAuth) {}

  /** The shared sign-in token, renewed by {@link GoogleAuth} when it nears expiry. */
  private async getToken(): Promise<string> {
    const token = await this.auth.getAccessToken();
    return token.value;
  }

  async findBackupFile(): Promise<BackupFile | undefined> {
    const params = new URLSearchParams({
      q: `name = '${BACKUP_FILE_NAME}' and trashed = false`,
      fields: "files(id,name,modifiedTime)",
      spaces: "drive",
      pageSize: "1",
      orderBy: "modifiedTime desc",
    });
    const result = await this.requestJson<DriveFileListResponse>(
      "GET",
      `${DRIVE_API}/files?${params.toString()}`,
    );
    const file = result.files?.[0];
    return file !== undefined ? toBackupFile(file) : undefined;
  }

  async createBackupFile(blob: Uint8Array): Promise<BackupFile> {
    const metadata = { name: BACKUP_FILE_NAME, mimeType: BACKUP_MIME };
    const body = multipartRelatedBody(metadata, blob);
    const created = await this.requestJson<DriveFileResource>(
      "POST",
      `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime`,
      { contentType: `multipart/related; boundary=${MULTIPART_BOUNDARY}`, body },
    );
    return toBackupFile(created);
  }

  async updateBackupFile(id: string, blob: Uint8Array): Promise<void> {
    await this.requestJson<DriveFileResource>(
      "PATCH",
      `${DRIVE_UPLOAD_API}/files/${id}?uploadType=media&fields=id`,
      { contentType: BACKUP_MIME, body: toArrayBuffer(blob) },
    );
  }

  async downloadBackupFile(id: string): Promise<Uint8Array> {
    const token = await this.getToken();
    const response = await fetchWithRetry(`${DRIVE_API}/files/${id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
      throw new BackupNotFoundError();
    }
    if (!response.ok) {
      throw new Error(`Drive API responded ${response.status} for download`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Authorised fetch that returns the parsed JSON body. `payload`, when present, sets the
   * request body and its `Content-Type` (media or multipart); GET calls omit it.
   */
  private async requestJson<T>(
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: { contentType: string; body: BodyInit },
  ): Promise<T> {
    const token = await this.getToken();
    const response = await fetchWithRetry(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "Content-Type": payload.contentType } : {}),
      },
      ...(payload !== undefined ? { body: payload.body } : {}),
    });
    if (!response.ok) {
      throw new Error(`Drive API responded ${response.status} for ${method} ${url}`);
    }
    return (await response.json()) as T;
  }
}

/** Build a Drive `multipart/related` upload body: JSON metadata part + JSON media part. */
function multipartRelatedBody(metadata: unknown, media: Uint8Array): ArrayBuffer {
  const encoder = new TextEncoder();
  const preamble = encoder.encode(
    `--${MULTIPART_BOUNDARY}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify(metadata)}\r\n` +
      `--${MULTIPART_BOUNDARY}\r\n` +
      `Content-Type: ${BACKUP_MIME}\r\n\r\n`,
  );
  const epilogue = encoder.encode(`\r\n--${MULTIPART_BOUNDARY}--`);
  const buffer = new ArrayBuffer(preamble.length + media.length + epilogue.length);
  const body = new Uint8Array(buffer);
  body.set(preamble, 0);
  body.set(media, preamble.length);
  body.set(epilogue, preamble.length + media.length);
  return buffer;
}

/** Copy `bytes` into a fresh `ArrayBuffer` — an unambiguous `BodyInit` for `fetch`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
