// SPDX-License-Identifier: Apache-2.0
/**
 * Dependency-free in-memory `Store` implementation.
 *
 * A complete `Store` port with no Dexie/IndexedDB, so pure orchestration (`runScan`,
 * `enforce`, …) can run in a plain node environment. It backs both **demo mode**
 * (`@inboxclinic/core/demo`, shippable) and the **tests** (`@inboxclinic/core/testing`
 * re-exports it). `packages/store` provides the real Dexie adapter.
 */

import type {
  AnalyticsStore,
  ProfileStore,
  PromptRepo,
  Repo,
  SingletonStore,
  Store,
} from "../store";
import type {
  DailyAnalytics,
  Domain,
  FilterSyncState,
  MonthlyAnalytics,
  Profile,
  Prompt,
  Sender,
  Setting,
} from "../store";

class InMemoryRepo<T> implements Repo<T> {
  protected readonly items = new Map<string, T>();

  constructor(private readonly keyOf: (value: T) => string) {}

  get(id: string): Promise<T | undefined> {
    return Promise.resolve(this.items.get(id));
  }

  put(value: T): Promise<void> {
    this.items.set(this.keyOf(value), value);
    return Promise.resolve();
  }

  bulkPut(values: T[]): Promise<void> {
    for (const value of values) this.items.set(this.keyOf(value), value);
    return Promise.resolve();
  }

  query(filter: Partial<T>): Promise<T[]> {
    const keys = Object.keys(filter) as (keyof T)[];
    const all = [...this.items.values()];
    if (keys.length === 0) return Promise.resolve(all);
    return Promise.resolve(all.filter((item) => keys.every((k) => item[k] === filter[k])));
  }

  delete(id: string): Promise<void> {
    this.items.delete(id);
    return Promise.resolve();
  }

  clear(): void {
    this.items.clear();
  }
}

class InMemoryPromptRepo extends InMemoryRepo<Prompt> implements PromptRepo {
  constructor() {
    super((p) => p.id);
  }

  byPriority(limit: number): Promise<Prompt[]> {
    const sorted = [...this.items.values()].sort((a, b) => b.priorityScore - a.priorityScore);
    return Promise.resolve(sorted.slice(0, Math.max(0, limit)));
  }
}

class InMemoryProfileStore implements ProfileStore {
  private record: Profile | undefined;

  get(): Promise<Profile | undefined> {
    return Promise.resolve(this.record);
  }

  put(value: Profile): Promise<void> {
    this.record = value;
    return Promise.resolve();
  }

  clear(): void {
    this.record = undefined;
  }
}

class InMemoryAnalyticsStore implements AnalyticsStore {
  private readonly days = new Map<string, DailyAnalytics>();
  private readonly months = new Map<string, MonthlyAnalytics>();

  day(date: string): Promise<DailyAnalytics | undefined> {
    return Promise.resolve(this.days.get(date));
  }

  putDay(value: DailyAnalytics): Promise<void> {
    this.days.set(value.date, value);
    return Promise.resolve();
  }

  recentDays(limit: number): Promise<DailyAnalytics[]> {
    const sorted = [...this.days.values()].sort((a, b) => b.date.localeCompare(a.date));
    return Promise.resolve(sorted.slice(0, Math.max(0, limit)));
  }

  month(month: string): Promise<MonthlyAnalytics | undefined> {
    return Promise.resolve(this.months.get(month));
  }

  putMonth(value: MonthlyAnalytics): Promise<void> {
    this.months.set(value.month, value);
    return Promise.resolve();
  }

  /** All daily records (for `exportAll`); order is not significant. */
  allDays(): DailyAnalytics[] {
    return [...this.days.values()];
  }

  /** All monthly records (for `exportAll`); order is not significant. */
  allMonths(): MonthlyAnalytics[] {
    return [...this.months.values()];
  }

  clear(): void {
    this.days.clear();
    this.months.clear();
  }
}

class InMemorySingletonStore<T> implements SingletonStore<T> {
  private record: T | undefined;

  get(): Promise<T | undefined> {
    return Promise.resolve(this.record);
  }

  put(value: T): Promise<void> {
    this.record = value;
    return Promise.resolve();
  }

  clear(): void {
    this.record = undefined;
  }
}

/** A dependency-free `Store` implementation (demo mode + tests). */
export class InMemoryStore implements Store {
  readonly profile = new InMemoryProfileStore();
  readonly senders = new InMemoryRepo<Sender>((s) => s.id);
  readonly domains = new InMemoryRepo<Domain>((d) => d.id);
  readonly prompts = new InMemoryPromptRepo();
  readonly analytics = new InMemoryAnalyticsStore();
  readonly filterSync = new InMemorySingletonStore<FilterSyncState>();
  readonly settings = new InMemoryRepo<Setting>((s) => s.key);

  /**
   * Serialise every store as a `{ tableName: rows[] }` dump — the same format the Dexie
   * adapter produces, so a blob round-trips through either `Store` implementation.
   * Singleton stores (profile, filterSyncState) dump as a 0-or-1-element array.
   */
  async exportAll(): Promise<Uint8Array> {
    const profile = await this.profile.get();
    const filterSyncState = await this.filterSync.get();
    const dump = {
      profile: profile !== undefined ? [profile] : [],
      senders: await this.senders.query({}),
      domains: await this.domains.query({}),
      prompts: await this.prompts.query({}),
      analyticsDaily: this.analytics.allDays(),
      analyticsMonthly: this.analytics.allMonths(),
      filterSyncState: filterSyncState !== undefined ? [filterSyncState] : [],
      settings: await this.settings.query({}),
    };
    return new TextEncoder().encode(JSON.stringify(dump));
  }

  /** Replace every store from a dump produced by {@link exportAll} (or the Dexie adapter). */
  async importAll(blob: Uint8Array): Promise<void> {
    const dump = JSON.parse(new TextDecoder().decode(blob)) as {
      profile?: Profile[];
      senders?: Sender[];
      domains?: Domain[];
      prompts?: Prompt[];
      analyticsDaily?: DailyAnalytics[];
      analyticsMonthly?: MonthlyAnalytics[];
      filterSyncState?: FilterSyncState[];
      settings?: Setting[];
    };
    await this.wipeAll();
    if (dump.profile?.[0] !== undefined) await this.profile.put(dump.profile[0]);
    await this.senders.bulkPut(dump.senders ?? []);
    await this.domains.bulkPut(dump.domains ?? []);
    await this.prompts.bulkPut(dump.prompts ?? []);
    for (const day of dump.analyticsDaily ?? []) await this.analytics.putDay(day);
    for (const month of dump.analyticsMonthly ?? []) await this.analytics.putMonth(month);
    if (dump.filterSyncState?.[0] !== undefined) await this.filterSync.put(dump.filterSyncState[0]);
    await this.settings.bulkPut(dump.settings ?? []);
  }

  wipeAll(): Promise<void> {
    this.profile.clear();
    this.senders.clear();
    this.domains.clear();
    this.prompts.clear();
    this.analytics.clear();
    this.filterSync.clear();
    this.settings.clear();
    return Promise.resolve();
  }
}

/** Convenience factory mirroring the Dexie adapter's `createDexieStore`. */
export function createInMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}
