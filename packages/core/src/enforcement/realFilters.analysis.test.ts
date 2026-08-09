// SPDX-License-Identifier: Apache-2.0
/**
 * Replay a REAL account's filters through the compiler and the confirm-first
 * suggesters — docs/design-testing.md Decision 9 (real-account probes).
 *
 * Every other tier feeds these functions filters we invented, which means they only ever
 * meet the shapes we already thought of. A real mailbox has years of hand-built rules:
 * multi-clause criteria, actions we don't model, wildcards in unexpected places. This spec
 * points the shipped code at that mess and asserts the guarantees that must hold whatever
 * it contains.
 *
 * Skipped unless a dump is supplied, so it costs nothing in CI:
 *
 *   ./scripts/qa-gmail-probe.py filters --json --out .local/filters.json
 *   INBOXCLINIC_FILTER_FIXTURE=$PWD/.local/filters.json npx vitest run realFilters
 *
 * The dump carries the account's own sender addresses — keep it in the gitignored
 * `.local/`, and never paste raw output into an issue.
 */

import { describe, expect, it } from "vitest";

import { reconcileFilters } from "./compileFilters";
import { FILTER_SYNC_KEY } from "./enforce";
import {
  carriesUnmodelledCriteria,
  isBlockFilter,
  parseFilterSubjects,
  unwrapExcludeFrom,
} from "./filterShape";
import { filterKey, suggestFilterOptimisations } from "./optimiseFilters";
import { createInMemoryStore, MockGmailClient } from "../testing";
import type { FilterSpec, NativeFilter } from "../ports/GmailClient";

// `packages/core` compiles with `types: []` on purpose — the core is pure and
// provider-agnostic, and nothing in it may reach for a runtime API. This manual-tier spec
// is the one exception, so the escape hatch is declared here rather than by widening the
// package's types and weakening that guard for all of src.
declare const process: { env: Record<string, string | undefined> };

const FIXTURE = process.env.INBOXCLINIC_FILTER_FIXTURE;

/**
 * A Gmail filter as the API returned it, beside our projection of it. The port models
 * `from` and `negatedQuery` and drops everything else Gmail supports (`to`, `subject`,
 * `query`, …) — so the raw form is what makes that loss visible to these tests.
 */
interface RawFilter {
  id: string;
  criteria: Record<string, unknown>;
  action: Record<string, unknown>;
}

/**
 * Load the dump. An absolute path; JSON is imported rather than read off disk.
 *
 * The probe dumps the raw `negatedQuery` in `raw` and leaves `excludeFrom` unset on
 * `filters` (#216) — so it is derived here, through the same `unwrapExcludeFrom` the
 * provider adapter calls in production, rather than trusting a second implementation the
 * probe would otherwise have to keep in step by hand.
 */
const load = async (): Promise<{ filters: NativeFilter[]; raw: RawFilter[] }> => {
  const mod = (await import(/* @vite-ignore */ FIXTURE as string)) as {
    default: { filters: NativeFilter[]; raw: RawFilter[] };
  };
  const { filters, raw } = mod.default;
  const rawById = new Map(raw.map((r) => [r.id, r]));
  const withExcludeFrom = filters.map((filter) => {
    const negatedQuery = rawById.get(filter.id)?.criteria.negatedQuery;
    const excludeFrom = unwrapExcludeFrom(
      typeof negatedQuery === "string" ? negatedQuery : undefined,
    );
    return excludeFrom !== undefined ? { ...filter, excludeFrom } : filter;
  });
  return { filters: withExcludeFrom, raw };
};

/** The fields our model reads. Everything else in `criteria` is invisible to it. */
const MODELLED_CRITERIA = new Set(["from", "negatedQuery"]);

/** A client + store presenting the real filters, with `managed` treated as app-created. */
async function seeded(filters: NativeFilter[], managed: string[]) {
  const gmail = new MockGmailClient();
  gmail.seedFilters(filters);
  const store = createInMemoryStore();
  await store.filterSync.put({
    key: FILTER_SYNC_KEY,
    lastSyncAt: null,
    totalFilters: filters.length,
    managedFilterIds: managed,
    enumeratedDomains: [],
  });
  return { gmail, store };
}

/** The desired-set form of an existing filter: everything the signature covers, minus id. */
const asSpec = (filter: NativeFilter): FilterSpec => ({
  from: filter.from,
  ...(filter.excludeFrom !== undefined ? { excludeFrom: filter.excludeFrom } : {}),
  addLabelIds: filter.addLabelIds,
  removeLabelIds: filter.removeLabelIds,
});

describe.skipIf(FIXTURE === undefined)("real account filters", () => {
  it("reports what the shape parser makes of them", async () => {
    const { filters } = await load();
    const blockShaped = filters.filter(isBlockFilter);
    const parsed = blockShaped.map((f) => ({
      from: f.from,
      subjects: parseFilterSubjects(f.from),
    }));
    const unparsed = parsed.filter((p) => p.subjects.length === 0);

    // Evidence, not a verdict: a filter our parser can't read is not a bug by itself —
    // it just means the tidy-up and adoption paths will never consider it.
    console.log(
      `${filters.length} filters; ${blockShaped.length} block-shaped; ` +
        `${unparsed.length} block-shaped but unparsed by parseFilterSubjects`,
    );
    for (const p of unparsed) console.log(`  unparsed criteria: ${p.from}`);
    expect(filters.length).toBeGreaterThan(0);
  });

  it("does not treat filters as identical when they differ in criteria it cannot see", async () => {
    const { filters, raw } = await load();
    const rawById = new Map(raw.map((r) => [r.id, r]));

    const dropped = new Set<string>();
    for (const r of raw) {
      for (const field of Object.keys(r.criteria)) {
        if (!MODELLED_CRITERIA.has(field)) dropped.add(field);
      }
    }
    console.log(
      dropped.size === 0
        ? "no criteria fields outside the model in this account"
        : `criteria fields the model drops: ${[...dropped].sort().join(", ")}`,
    );

    // Only filters the code will actually compare. A filter carrying criteria we cannot see
    // is set aside before any identity reasoning (#212), so including it here would assert a
    // rule the app no longer follows — and keep reporting a defect that is fixed, which is
    // how a harness teaches people to ignore it.
    const comparable = filters.filter((f) => !carriesUnmodelledCriteria(f));
    console.log(
      `${filters.length - comparable.length} of ${filters.length} filters set aside as ` +
        "carrying criteria the model cannot represent",
    );

    // Group by the identity duplicate-detection, reconcile signatures and adoption all
    // compare on. Two filters sharing it MUST be the same rule — otherwise the tidy-up
    // offers to delete one as a "duplicate" of the other, reconcile thinks it owns a rule
    // that does something else, and adoption claims one on a resemblance that isn't real.
    const groups = new Map<string, NativeFilter[]>();
    for (const f of comparable) groups.set(filterKey(f), [...(groups.get(filterKey(f)) ?? []), f]);

    const collisions: string[] = [];
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const shapes = new Set(group.map((f) => JSON.stringify(rawById.get(f.id)?.criteria ?? {})));
      if (shapes.size > 1) {
        collisions.push(`${group.length} filters share the dedup key "${key}" but differ:`);
        for (const shape of shapes) collisions.push(`    ${shape}`);
      }
    }
    for (const line of collisions) console.log(line);

    expect(collisions).toEqual([]);
  });

  it("never offers an untracked filter for deletion, whatever the account contains", async () => {
    const { filters } = await load();
    // Nothing is managed — the state a real account is in before the app ever runs.
    const { gmail, store } = await seeded(filters, []);

    const suggestions = await suggestFilterOptimisations(gmail, store);

    // The #29/#190 guarantee, checked against real rules rather than invented ones.
    expect(suggestions.flatMap((s) => s.removeFilterIds)).toEqual([]);
  });

  it("proposes a coherent tidy-up when the account's rules are treated as app-created", async () => {
    const { filters } = await load();
    // Pretend the app built them, which is what the consolidation logic is written for —
    // the only way real-world rule shapes exercise it at all.
    const { gmail, store } = await seeded(
      filters,
      filters.map((f) => f.id),
    );

    const suggestions = await suggestFilterOptimisations(gmail, store);
    const removed = suggestions.flatMap((s) => s.removeFilterIds);

    console.log(`${suggestions.length} suggestion(s) over ${filters.length} real filters:`);
    for (const s of suggestions) console.log(`  [${s.kind}] ${s.description}`);

    // Whatever it proposes must be self-consistent: no filter deleted twice (an accepted
    // set would 404 on the second delete), and every id must exist in the account.
    expect(new Set(removed).size).toBe(removed.length);
    const ids = new Set(filters.map((f) => f.id));
    for (const id of removed) expect(ids.has(id)).toBe(true);
    // A consolidation must always replace what it removes, never just delete.
    for (const s of suggestions.filter((x) => x.kind === "consolidate")) {
      expect(s.createFilter).toBeDefined();
    }
  });

  it("is idempotent against the account's own rules — reconcile proposes no churn", async () => {
    const { filters } = await load();

    // Over the filters the app can actually own. A foreign one is excluded deliberately:
    // desiring its shape compiles a plain replacement beside it (#217), which is the rule
    // working, not churn — so including it here would assert the opposite of the design.
    const ownable = filters.filter((f) => !carriesUnmodelledCriteria(f));

    // Desired set == what's already there, all managed: a correct reconcile is a no-op.
    // Any create/delete here is the signature failing to round-trip real criteria — the
    // churn-on-every-sync failure, seen against real data instead of fixtures.
    const plan = reconcileFilters(ownable.map(asSpec), filters, new Set(ownable.map((f) => f.id)));

    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });
});
