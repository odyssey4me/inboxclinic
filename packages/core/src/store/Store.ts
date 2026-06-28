/**
 * `Store` and `Repo<T>` ports — on-device persistence interface.
 *
 * See docs/design-local-store-schema.md ("Repository port") and architecture.md §6.
 * Product logic depends on these interfaces, never on Dexie directly, so the backing
 * store is swappable (a Dexie adapter in `packages/store`; an in-memory fake in
 * `../testing`). Export/import/wipe back the privacy contract (architecture.md §5).
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

/** Generic per-entity repository keyed by a string id. */
export interface Repo<T> {
  get(id: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  bulkPut(values: T[]): Promise<void>;
  /** Equality-match query over a subset of fields. Empty filter returns all. */
  query(filter: Partial<T>): Promise<T[]>;
  delete(id: string): Promise<void>;
}

/** Single-record store (e.g. the account profile). */
export interface ProfileStore {
  get(): Promise<Profile | undefined>;
  put(value: Profile): Promise<void>;
}

/** Prompt repository with a priority-ordered read (M2+). */
export interface PromptRepo extends Repo<Prompt> {
  byPriority(limit: number): Promise<Prompt[]>;
}

/** Daily/monthly analytics accessors (M6). */
export interface AnalyticsStore {
  day(date: string): Promise<DailyAnalytics | undefined>;
  putDay(value: DailyAnalytics): Promise<void>;
  /** Most recent days first (by `date`), bounded by `limit`, for range rollups. */
  recentDays(limit: number): Promise<DailyAnalytics[]>;
  month(month: string): Promise<MonthlyAnalytics | undefined>;
  putMonth(value: MonthlyAnalytics): Promise<void>;
}

/** A singleton-record store. */
export interface SingletonStore<T> {
  get(): Promise<T | undefined>;
  put(value: T): Promise<void>;
}

/**
 * The full on-device store port. M1 exercises `profile`, `senders`, and `domains`;
 * the rest are present so the contract is complete and adapters satisfy it whole.
 */
export interface Store {
  profile: ProfileStore;
  senders: Repo<Sender>;
  domains: Repo<Domain>;
  prompts: PromptRepo;
  analytics: AnalyticsStore;
  filterSync: SingletonStore<FilterSyncState>;
  settings: Repo<Setting>;
  /** Serialise every store to a JSON blob (export / backup). */
  exportAll(): Promise<Uint8Array>;
  /** Replace all stores from a previously exported blob (restore). */
  importAll(blob: Uint8Array): Promise<void>;
  /** Clear all stores (delete-my-data). */
  wipeAll(): Promise<void>;
}
