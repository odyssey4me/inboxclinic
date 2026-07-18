// SPDX-License-Identifier: Apache-2.0
/**
 * Parse + shape-validate a store export blob (restore/import boundary).
 *
 * The blob comes from the user's own Drive file, but it may be truncated, hand-edited, or
 * corrupted, so `importAll` must never crash or **partially write / wipe** the store on bad
 * input (design-backup-restore.md Decision 4). This is the single, pure gate both Store
 * implementations run *before* touching any data: it decodes, `JSON.parse`s, and validates the
 * top-level shape, throwing a typed {@link InvalidBackupError} on anything malformed. Only when
 * it returns does a store wipe+write proceed, so a rejected import leaves the store untouched.
 *
 * Validation is deliberately shallow — a restore is the user's *own* data, not adversarial
 * input, so the goal is crash/corruption safety, not schema enforcement: every known table, if
 * present, must be an array of objects. Per-field validation is out of scope (a structurally
 * valid but stale-schema row is the migration layer's concern, not this gate's).
 */

import type {
  DailyAnalytics,
  Domain,
  FilterSyncState,
  MonthlyAnalytics,
  Profile,
  Prompt,
  Sender,
  Setting,
} from "./types";

/** Thrown when a restore blob is not a well-formed store dump. Store is left untouched. */
export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBackupError";
  }
}

/** A validated store dump — the `{ tableName: rows[] }` shape `exportAll` produces. */
export interface StoreDump {
  profile: Profile[];
  senders: Sender[];
  domains: Domain[];
  prompts: Prompt[];
  analyticsDaily: DailyAnalytics[];
  analyticsMonthly: MonthlyAnalytics[];
  filterSyncState: FilterSyncState[];
  settings: Setting[];
}

/** The table keys in a dump, in a fixed order (matches `exportAll` / the Dexie schema). */
export const STORE_DUMP_TABLES = [
  "profile",
  "senders",
  "domains",
  "prompts",
  "analyticsDaily",
  "analyticsMonthly",
  "filterSyncState",
  "settings",
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Decode, parse, and shape-validate a restore blob. Returns a normalized {@link StoreDump}
 * (missing tables default to `[]`); throws {@link InvalidBackupError} — never a raw
 * `SyntaxError`/`TypeError` — on malformed input, without side effects.
 */
export function parseStoreDump(blob: Uint8Array): StoreDump {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(blob);
  } catch {
    throw new InvalidBackupError("backup is not valid UTF-8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidBackupError("backup is not valid JSON");
  }

  if (!isPlainObject(parsed)) {
    throw new InvalidBackupError("backup is not a JSON object");
  }

  const dump = {} as Record<(typeof STORE_DUMP_TABLES)[number], unknown[]>;
  for (const table of STORE_DUMP_TABLES) {
    const rows = parsed[table];
    if (rows === undefined) {
      dump[table] = [];
      continue;
    }
    if (!Array.isArray(rows)) {
      throw new InvalidBackupError(`backup table "${table}" is not an array`);
    }
    if (!rows.every(isPlainObject)) {
      throw new InvalidBackupError(`backup table "${table}" contains a non-object row`);
    }
    dump[table] = rows;
  }
  return dump as unknown as StoreDump;
}
