// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { compileFilters, reconcileFilters } from "./compileFilters";
import type { FilterSpec } from "../ports/GmailClient";

// Property-based coverage of the filter compiler/reconciler invariants (design-gmail-integration.md
// Decision 5). Example tests spot-check specific groupings; these assert the laws — cap, coverage,
// idempotence, and content-defined stability (#152) — hold across randomized blocked-domain sets.

/** A set of distinct lowercased blocked domains (compileFilters lowercases internally). */
const domainSet = (opts: { minLength?: number; maxLength?: number } = {}) =>
  fc
    .uniqueArray(fc.domain(), { minLength: opts.minLength ?? 0, maxLength: opts.maxLength ?? 60 })
    .map((ds) => [...new Set(ds.map((d) => d.toLowerCase()))]);

const asBlocked = (domains: string[]) => domains.map((domain) => ({ domain }));

/** The `*@domain` tokens across all compiled filters (sender/email filters aside). */
const coveredDomains = (filters: FilterSpec[]): string[] =>
  filters
    .flatMap((f) => f.from.split(" OR "))
    .filter((t) => t.startsWith("*@"))
    .map((t) => t.slice(2));

describe("compileFilters (properties)", () => {
  it("no OR-combine filter exceeds the maxDomainsPerFilter cap", () => {
    fc.assert(
      fc.property(domainSet(), fc.integer({ min: 1, max: 15 }), (domains, cap) => {
        const { filters } = compileFilters([], asBlocked(domains), { maxDomainsPerFilter: cap });
        for (const f of filters) {
          const domainTokens = f.from.split(" OR ").filter((t) => t.startsWith("*@"));
          expect(domainTokens.length).toBeLessThanOrEqual(cap);
        }
      }),
    );
  });

  it("covers every blocked domain exactly once", () => {
    fc.assert(
      fc.property(domainSet(), (domains) => {
        const { filters } = compileFilters([], asBlocked(domains));
        const covered = coveredDomains(filters);
        expect(new Set(covered).size).toBe(covered.length); // no duplicates
        expect([...covered].sort()).toEqual([...domains].sort()); // exactly the input set
      }),
    );
  });

  it("reconcile after applying the compiled set is a no-op (idempotent)", () => {
    fc.assert(
      fc.property(domainSet(), (domains) => {
        const { filters } = compileFilters([], asBlocked(domains));
        const existing = filters.map((f, i) => ({ ...f, id: `f${i}` }));
        const managed = new Set(existing.map((e) => e.id));
        const plan = reconcileFilters(filters, existing, managed);
        expect(plan.toCreate).toHaveLength(0);
        expect(plan.toDelete).toHaveLength(0);
      }),
    );
  });

  it("adding one domain re-chunks only locally — unrelated filters stay identical (#152)", () => {
    // Content-defined chunking disturbs only the local region (a small, roughly constant number
    // of filters — one chunk plus its re-sync tail), independent of set size. Positional slicing
    // would shift every downstream boundary, changing ~all filters. Over a large set the two are
    // decisively separated: `changed` stays a small fraction, never close to `before.length`.
    // The locality is probabilistic (re-sync waits for the next hash marker), so this asserts a
    // generous fraction, not a brittle absolute constant; a fixed seed keeps CI reproducible.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.domain(), { minLength: 150, maxLength: 250 }),
        fc.domain(),
        (base, extra) => {
          const baseSet = [...new Set(base.map((d) => d.toLowerCase()))];
          fc.pre(!baseSet.includes(extra.toLowerCase()));
          const before = compileFilters([], asBlocked(baseSet)).filters.map((f) => f.from);
          const after = compileFilters(
            [],
            asBlocked([extra.toLowerCase(), ...baseSet]),
          ).filters.map((f) => f.from);
          const changed = before.filter((f) => !after.includes(f)).length;
          expect(changed).toBeLessThanOrEqual(before.length / 2);
        },
      ),
      { seed: 20260718, numRuns: 80 },
    );
  });
});
