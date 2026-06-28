/**
 * Dexie implementation of the `Store` port.
 *
 * See docs/design-local-store-schema.md (object stores, indexes, export/import/wipe).
 * This is the production on-device adapter; product logic depends only on the `Store`
 * port in `@inboxclinic/core`, never on Dexie directly. Tests run it against
 * `fake-indexeddb` in a node environment.
 */

import Dexie, { type Table } from "dexie";
import type {
  AnalyticsStore,
  DailyAnalytics,
  Domain,
  FilterSyncState,
  MonthlyAnalytics,
  Profile,
  Prompt,
  PromptRepo,
  ProfileStore,
  Repo,
  Sender,
  Setting,
  SingletonStore,
  Store,
} from "@inboxclinic/core";

/** Schema version 1. Bump on any schema change (design-local-store-schema.md). */
const SCHEMA = {
  profile: "googleEmail",
  senders: "id, domain, trustStatus, category, updatedAt",
  domains: "id, trustStatus, updatedAt",
  prompts: "id, priorityScore, batchGroupId, expiresAt, resolvedAt",
  analyticsDaily: "date",
  analyticsMonthly: "month",
  filterSyncState: "key",
  settings: "key",
} as const;

class InboxClinicDexie extends Dexie {
  profile!: Table<Profile, string>;
  senders!: Table<Sender, string>;
  domains!: Table<Domain, string>;
  prompts!: Table<Prompt, string>;
  analyticsDaily!: Table<DailyAnalytics, string>;
  analyticsMonthly!: Table<MonthlyAnalytics, string>;
  filterSyncState!: Table<FilterSyncState, string>;
  settings!: Table<Setting, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores(SCHEMA);
  }
}

class DexieRepo<T> implements Repo<T> {
  constructor(protected readonly table: Table<T, string>) {}

  get(id: string): Promise<T | undefined> {
    return this.table.get(id);
  }

  async put(value: T): Promise<void> {
    await this.table.put(value);
  }

  async bulkPut(values: T[]): Promise<void> {
    await this.table.bulkPut(values);
  }

  query(filter: Partial<T>): Promise<T[]> {
    const keys = Object.keys(filter) as (keyof T)[];
    if (keys.length === 0) return this.table.toArray();
    return this.table.filter((record) => keys.every((k) => record[k] === filter[k])).toArray();
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(id);
  }
}

class DexiePromptRepo extends DexieRepo<Prompt> implements PromptRepo {
  byPriority(limit: number): Promise<Prompt[]> {
    return this.table.orderBy("priorityScore").reverse().limit(limit).toArray();
  }
}

class DexieProfileStore implements ProfileStore {
  constructor(private readonly db: InboxClinicDexie) {}

  get(): Promise<Profile | undefined> {
    return this.db.profile.toCollection().first();
  }

  async put(value: Profile): Promise<void> {
    await this.db.transaction("rw", this.db.profile, async () => {
      await this.db.profile.clear();
      await this.db.profile.put(value);
    });
  }
}

class DexieAnalyticsStore implements AnalyticsStore {
  constructor(private readonly db: InboxClinicDexie) {}

  day(date: string): Promise<DailyAnalytics | undefined> {
    return this.db.analyticsDaily.get(date);
  }

  async putDay(value: DailyAnalytics): Promise<void> {
    await this.db.analyticsDaily.put(value);
  }

  month(month: string): Promise<MonthlyAnalytics | undefined> {
    return this.db.analyticsMonthly.get(month);
  }

  async putMonth(value: MonthlyAnalytics): Promise<void> {
    await this.db.analyticsMonthly.put(value);
  }
}

class DexieSingletonStore<T> implements SingletonStore<T> {
  constructor(private readonly table: Table<T, string>) {}

  get(): Promise<T | undefined> {
    return this.table.toCollection().first();
  }

  async put(value: T): Promise<void> {
    await this.table.put(value);
  }
}

/** The on-device store, backed by Dexie / IndexedDB. */
export class DexieStore implements Store {
  private readonly db: InboxClinicDexie;
  readonly profile: ProfileStore;
  readonly senders: Repo<Sender>;
  readonly domains: Repo<Domain>;
  readonly prompts: PromptRepo;
  readonly analytics: AnalyticsStore;
  readonly filterSync: SingletonStore<FilterSyncState>;
  readonly settings: Repo<Setting>;

  constructor(name = "inbox-clinic") {
    this.db = new InboxClinicDexie(name);
    this.profile = new DexieProfileStore(this.db);
    this.senders = new DexieRepo(this.db.senders);
    this.domains = new DexieRepo(this.db.domains);
    this.prompts = new DexiePromptRepo(this.db.prompts);
    this.analytics = new DexieAnalyticsStore(this.db);
    this.filterSync = new DexieSingletonStore(this.db.filterSyncState);
    this.settings = new DexieRepo(this.db.settings);
  }

  async exportAll(): Promise<Uint8Array> {
    const dump: Record<string, unknown[]> = {};
    await this.db.transaction("r", this.db.tables, async () => {
      for (const table of this.db.tables) {
        dump[table.name] = await table.toArray();
      }
    });
    return new TextEncoder().encode(JSON.stringify(dump));
  }

  async importAll(blob: Uint8Array): Promise<void> {
    const dump = JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown[]>;
    await this.db.transaction("rw", this.db.tables, async () => {
      for (const table of this.db.tables) {
        await table.clear();
        const rows = dump[table.name];
        if (rows !== undefined) await table.bulkPut(rows);
      }
    });
  }

  async wipeAll(): Promise<void> {
    await this.db.transaction("rw", this.db.tables, async () => {
      await Promise.all(this.db.tables.map((table) => table.clear()));
    });
  }

  /** Close the underlying connection (mainly for test isolation). */
  close(): void {
    this.db.close();
  }
}

/** Factory mirroring `createInMemoryStore` from `@inboxclinic/core/testing`. */
export function createDexieStore(name?: string): Store {
  return new DexieStore(name);
}
