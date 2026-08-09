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
import { isBlockFilter, parseFilterSubjects } from "./filterShape";
import { suggestFilterOptimisations } from "./optimiseFilters";
import { createInMemoryStore, MockGmailClient } from "../testing";
import type { FilterSpec, NativeFilter } from "../ports/GmailClient";

// `packages/core` compiles with `types: []` on purpose — the core is pure and
// provider-agnostic, and nothing in it may reach for a runtime API. This manual-tier spec
// is the one exception, so the escape hatch is declared here rather than by widening the
// package's types and weakening that guard for all of src.
declare const process: { env: Record<string, string | undefined> };

const FIXTURE = process.env.INBOXCLINIC_FILTER_FIXTURE;

/** Load the dump. An absolute path; JSON is imported rather than read off disk. */
const load = async (): Promise<NativeFilter[]> => {
  const mod = (await import(/* @vite-ignore */ FIXTURE as string)) as {
    default: NativeFilter[];
  };
  return mod.default;
};

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
    const filters = await load();
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

  it("never offers an untracked filter for deletion, whatever the account contains", async () => {
    const filters = await load();
    // Nothing is managed — the state a real account is in before the app ever runs.
    const { gmail, store } = await seeded(filters, []);

    const suggestions = await suggestFilterOptimisations(gmail, store);

    // The #29/#190 guarantee, checked against real rules rather than invented ones.
    expect(suggestions.flatMap((s) => s.removeFilterIds)).toEqual([]);
  });

  it("proposes a coherent tidy-up when the account's rules are treated as app-created", async () => {
    const filters = await load();
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
    const filters = await load();

    // Desired set == what's already there, all managed: a correct reconcile is a no-op.
    // Any create/delete here is the signature failing to round-trip real criteria — the
    // churn-on-every-sync failure, seen against real data instead of fixtures.
    const plan = reconcileFilters(filters.map(asSpec), filters, new Set(filters.map((f) => f.id)));

    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });
});
