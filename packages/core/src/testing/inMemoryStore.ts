/**
 * In-memory `Store` fake for tests.
 *
 * See docs/design-testing.md. A dependency-free implementation of the `Store` port
 * (no Dexie, no IndexedDB) so pure orchestration like `runScan` can be exercised in
 * a plain node environment. `packages/store` provides the real Dexie adapter.
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
    return Promise.resolve(sorted.slice(0, limit));
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

  month(month: string): Promise<MonthlyAnalytics | undefined> {
    return Promise.resolve(this.months.get(month));
  }

  putMonth(value: MonthlyAnalytics): Promise<void> {
    this.months.set(value.month, value);
    return Promise.resolve();
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

/** A dependency-free `Store` implementation for tests. */
export class InMemoryStore implements Store {
  readonly profile = new InMemoryProfileStore();
  readonly senders = new InMemoryRepo<Sender>((s) => s.id);
  readonly domains = new InMemoryRepo<Domain>((d) => d.id);
  readonly prompts = new InMemoryPromptRepo();
  readonly analytics = new InMemoryAnalyticsStore();
  readonly filterSync = new InMemorySingletonStore<FilterSyncState>();
  readonly settings = new InMemoryRepo<Setting>((s) => s.key);

  async exportAll(): Promise<Uint8Array> {
    const dump = {
      profile: await this.profile.get(),
      senders: await this.senders.query({}),
      domains: await this.domains.query({}),
    };
    return new TextEncoder().encode(JSON.stringify(dump));
  }

  importAll(): Promise<void> {
    return Promise.reject(new Error("InMemoryStore.importAll is not implemented"));
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
