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
 *
 * **One carve-out, deliberately narrow:** a field whose absence would leak `undefined` past a
 * non-optional type is defaulted here, because restore is the one path the Dexie migration
 * never sees — it writes rows straight through, and an upgrade only runs on a version change.
 * `Domain.exceptionDomains` (#183) is the first such field; `FilterSyncState.enumeratedDomains`
 * (#208) the second. Note the double cast on the return means the compiler will NOT remind you:
 * adding a required field to a stored type means adding its default here too, or a restored
 * record silently violates its own type.
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

// Each table's primary-key field (the Dexie schema's inline key). A row missing it is unstorable
// — Dexie's `bulkPut` would reject it (rolling back its transaction), and the in-memory store
// would silently write it under an `undefined` key. Validating the key here rejects such a row at
// the gate for BOTH backends uniformly, before any wipe — closing that data-loss asymmetry (#166).
const KEY_FIELD: Record<(typeof STORE_DUMP_TABLES)[number], string> = {
  profile: "googleEmail",
  senders: "id",
  domains: "id",
  prompts: "id",
  analyticsDaily: "date",
  analyticsMonthly: "month",
  filterSyncState: "key",
  settings: "key",
};

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
    const keyField = KEY_FIELD[table];
    if (!rows.every((row) => typeof row[keyField] === "string" && row[keyField] !== "")) {
      throw new InvalidBackupError(
        `backup table "${table}" has a row missing its "${keyField}" key`,
      );
    }
    dump[table] = rows;
  }
  // A backup taken before `Domain.exceptionDomains` existed has no such field, and restore
  // writes rows straight through — the Dexie upgrade only runs on a version change, so it
  // never sees them. Default here, the one gate both backends share, so a restored record
  // can't hand `undefined` to code typed against an array (#183).
  for (const row of dump.domains) {
    if (!Array.isArray((row as Record<string, unknown>).exceptionDomains)) {
      (row as Record<string, unknown>).exceptionDomains = [];
    }
  }
  // Same for `FilterSyncState.enumeratedDomains` (#208) — a backup taken before the filter form
  // was tracked carries no such field.
  for (const row of dump.filterSyncState) {
    if (!Array.isArray((row as Record<string, unknown>).enumeratedDomains)) {
      (row as Record<string, unknown>).enumeratedDomains = [];
    }
  }
  return dump as unknown as StoreDump;
}
