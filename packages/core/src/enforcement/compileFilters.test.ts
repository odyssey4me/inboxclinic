// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  compileFilters,
  reconcileFilters,
  DEFAULT_FILTER_SOFT_CAP,
  DEFAULT_MAX_CRITERIA_CHARS,
} from "./compileFilters";
import type { FilterSpec, NativeFilter } from "../ports/GmailClient";

const sender = (email: string): { email: string; domain: string } => ({
  email,
  domain: email.split("@")[1] ?? "example.com",
});

/** The domains covered by plain `*@domain` OR-combine filters (exception + sender filters aside), sorted. */
const plainDomainsCovered = (filters: FilterSpec[]): string[] =>
  filters
    .filter((f) => f.excludeFrom === undefined)
    .flatMap((f) => f.from.split(" OR "))
    .filter((token) => token.startsWith("*@"))
    .map((token) => token.slice(2))
    .sort();

describe("compileFilters", () => {
  it("maps a single blocked sender to a from:<address> Trash/skip-inbox filter", () => {
    const { filters } = compileFilters([sender("spam@a.test")], []);
    expect(filters).toEqual([
      { from: "spam@a.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("aggregates to one *@domain filter once 3+ senders of a domain are blocked", () => {
    const { filters } = compileFilters(
      [sender("a@x.test"), sender("b@x.test"), sender("c@x.test")],
      [],
    );
    expect(filters).toEqual([
      { from: "*@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("keeps per-address filters below the domain threshold (2 senders)", () => {
    const { filters } = compileFilters([sender("a@x.test"), sender("b@x.test")], []);
    expect(filters.map((f) => f.from)).toEqual(["a@x.test", "b@x.test"]);
  });

  it("treats an explicitly blocked domain as aggregated regardless of sender count", () => {
    const { filters } = compileFilters([sender("a@x.test")], [{ domain: "x.test" }]);
    expect(filters).toEqual([
      { from: "*@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("carves exception addresses out of a domain filter via excludeFrom, sorted (#145)", () => {
    const { filters } = compileFilters(
      [],
      [{ domain: "shop.test", excludeAddresses: ["vip@shop.test", "boss@shop.test"] }],
    );
    expect(filters).toEqual<FilterSpec[]>([
      {
        from: "*@shop.test",
        excludeFrom: "boss@shop.test OR vip@shop.test",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);
  });

  it("gives an exception-carrying domain its own filter, and covers the plain domains (#145)", () => {
    const { filters } = compileFilters(
      [],
      [
        { domain: "a.test" },
        { domain: "b.test" },
        { domain: "c.test", excludeAddresses: ["vip@c.test"] },
      ],
    );
    // The exception-carrying domain always gets its OWN filter (an OR-group can't share one exclusion).
    expect(filters.find((f) => f.from === "*@c.test")?.excludeFrom).toBe("vip@c.test");
    // The plain domains are each covered exactly once, never folded into the exception filter.
    expect(plainDomainsCovered(filters)).toEqual(["a.test", "b.test"]);
  });

  it("OR-combines plain domains into chunks no larger than the cap, covering each once", () => {
    const domains = Array.from({ length: 12 }, (_, i) => ({ domain: `d${i}.com` }));
    const { filters } = compileFilters([], domains);
    // Every chunk honours the ≤10 OR-combine cap...
    for (const f of filters) expect(f.from.split(" OR ").length).toBeLessThanOrEqual(10);
    // ...12 > cap, so it can't be a single filter...
    expect(filters.length).toBeGreaterThanOrEqual(2);
    // ...and every domain is covered exactly once.
    expect(plainDomainsCovered(filters)).toEqual(domains.map((d) => d.domain).sort());
  });

  it("respects the maxDomainsPerFilter cap", () => {
    const domains = [{ domain: "a.test" }, { domain: "b.test" }, { domain: "c.test" }];
    const { filters } = compileFilters([], domains, { maxDomainsPerFilter: 2 });
    for (const f of filters) expect(f.from.split(" OR ").length).toBeLessThanOrEqual(2);
    expect(plainDomainsCovered(filters)).toEqual(["a.test", "b.test", "c.test"]);
  });

  it("degrades to one domain per filter at maxDomainsPerFilter=1 (#152)", () => {
    const domains = [{ domain: "a.test" }, { domain: "b.test" }, { domain: "c.test" }];
    const { filters } = compileFilters([], domains, { maxDomainsPerFilter: 1 });
    expect(filters.map((f) => f.from).sort()).toEqual(["*@a.test", "*@b.test", "*@c.test"]);
  });

  it("keeps unrelated domains' filters stable when one domain is added (#152)", () => {
    const base = Array.from({ length: 40 }, (_, i) => ({
      domain: `d${String(i).padStart(2, "0")}.com`,
    }));
    const before = compileFilters([], base).filters.map((f) => f.from);
    // Insert one new domain that sorts to the very front.
    const after = compileFilters([], [{ domain: "aaa-new.test" }, ...base]).filters.map(
      (f) => f.from,
    );
    // Positional slicing would shift every downstream chunk boundary; content-defined chunking
    // must leave all but the locally-affected filter(s) byte-for-byte identical.
    const unchanged = before.filter((f) => after.includes(f));
    expect(unchanged.length).toBeGreaterThanOrEqual(before.length - 2);
  });

  it("stops creating filters at the soft cap and surfaces skippedAtCap + capReached", () => {
    const senders = Array.from({ length: 5 }, (_, i) => sender(`s${i}@u${i}.com`));
    const { filters, capReached, skippedAtCap } = compileFilters(senders, [], { softCap: 3 });
    expect(filters).toHaveLength(3);
    expect(capReached).toBe(true);
    expect(skippedAtCap).toBe(2);
  });

  it("does not flag the cap when the desired set fits", () => {
    const result = compileFilters([sender("a@a.test")], []);
    expect(result.capReached).toBe(false);
    expect(result.skippedAtCap).toBe(0);
  });

  it("prefers domain aggregation first when the cap bites", () => {
    const senders = [
      sender("a@agg.test"),
      sender("b@agg.test"),
      sender("c@agg.test"),
      sender("solo@other.test"),
    ];
    const { filters } = compileFilters(senders, [], { softCap: 1 });
    expect(filters).toEqual([
      { from: "*@agg.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("deduplicates and lowercases sender addresses", () => {
    const { filters } = compileFilters([sender("Dup@X.test"), sender("dup@x.test")], []);
    expect(filters.map((f) => f.from)).toEqual(["dup@x.test"]);
  });

  it("uses the documented soft-cap default", () => {
    expect(DEFAULT_FILTER_SOFT_CAP).toBe(450);
  });

  it("uses the documented criteria-length default", () => {
    expect(DEFAULT_MAX_CRITERIA_CHARS).toBe(1500);
  });

  describe("exception overflow (#191)", () => {
    // Real overflow takes ~100 exceptions against the 1500-char budget; these tests shrink
    // the budget instead, so the intent stays legible without a wall of addresses.
    const manyExceptions = Array.from({ length: 6 }, (_, i) => `vip${i}@shop.test`);

    it("keeps the single carve-out filter while the criteria fit", () => {
      const { filters, exceptionOverflows } = compileFilters(
        [],
        [{ domain: "shop.test", excludeAddresses: manyExceptions }],
      );
      expect(exceptionOverflows).toEqual([]);
      expect(filters).toHaveLength(1);
      expect(filters[0]?.excludeFrom).toBe(manyExceptions.join(" OR "));
    });

    it("counts the query wrapper the adapter adds around the exclusion (#191)", () => {
      // The adapter sends `negatedQuery: from:(<addresses>)`, so the wrapper's 7 characters
      // are part of the criteria. Budget = from + wrapper + addresses exactly, so one char
      // less must overflow — measuring the bare address list would call this a fit.
      const domain = "shop.test";
      const addresses = ["a@shop.test", "b@shop.test"];
      const exact = `*@${domain}`.length + "from:()".length + addresses.join(" OR ").length;

      const fits = compileFilters([], [{ domain, excludeAddresses: addresses }], {
        maxCriteriaChars: exact,
      });
      expect(fits.exceptionOverflows).toEqual([]);

      const overflows = compileFilters([], [{ domain, excludeAddresses: addresses }], {
        maxCriteriaChars: exact - 1,
      });
      expect(overflows.exceptionOverflows).toHaveLength(1);
    });

    it("holds an enumerated domain there until it is comfortably back under budget (#208)", () => {
      // The whole point is the asymmetry, so the sizes are exact. `*@shop.test` is 11 chars,
      // the wrapper 7, each `aN@shop.test` 11, joined by " OR " (4) — so n addresses cost
      // 15n + 14. With a budget of 100 the promote threshold is 80:
      //   n=6 → 104  over the budget       → degrade
      //   n=5 →  89  under 100, over 80    → the dead band: stays enumerated
      //   n=4 →  74  under 80              → promote back
      const domain = "shop.test";
      const addresses = (n: number): string[] =>
        Array.from({ length: n }, (_, i) => `a${i}@shop.test`);
      const compile = (n: number, enumerated: boolean) =>
        compileFilters(
          [],
          [
            {
              domain,
              excludeAddresses: addresses(n),
              blockedMemberAddresses: ["promo@shop.test"],
            },
          ],
          { maxCriteriaChars: 100, enumeratedDomains: enumerated ? [domain] : [] },
        );

      expect(compile(6, false).exceptionOverflows).toHaveLength(1);
      // The step a single threshold gets wrong: back under the budget, so it would rebuild the
      // broad filter — and the next added exception would tear it down again.
      expect(compile(5, true).exceptionOverflows).toHaveLength(1);
      expect(compile(4, true).exceptionOverflows).toEqual([]);
    });

    it("applies the full budget to a domain that is not already enumerated (#208)", () => {
      // Same 89-char carve-out that stays enumerated above — a domain arriving at it from the
      // broad form is under budget and stays broad. The threshold depends on where it already is.
      const { exceptionOverflows, filters } = compileFilters(
        [],
        [
          {
            domain: "shop.test",
            excludeAddresses: Array.from({ length: 5 }, (_, i) => `a${i}@shop.test`),
            blockedMemberAddresses: ["promo@shop.test"],
          },
        ],
        { maxCriteriaChars: 100 },
      );

      expect(exceptionOverflows).toEqual([]);
      expect(filters.map((f) => f.from)).toEqual(["*@shop.test"]);
    });

    it("degrades to one filter per still-blocked member when the carve-out won't fit", () => {
      const { filters, exceptionOverflows } = compileFilters(
        [],
        [
          {
            domain: "shop.test",
            excludeAddresses: manyExceptions,
            blockedMemberAddresses: ["promo@shop.test", "deals@shop.test", "vip0@shop.test"],
          },
        ],
        { maxCriteriaChars: 40 },
      );

      // No `*@shop.test` rule — a plain one would trash exactly the addresses being excepted.
      expect(filters.map((f) => f.from)).toEqual(["deals@shop.test", "promo@shop.test"]);
      expect(filters.every((f) => f.excludeFrom === undefined)).toBe(true);
      expect(exceptionOverflows).toEqual([
        { domain: "shop.test", strategy: "enumerate", exceptionCount: 6 },
      ]);
    });

    it("enumerates a domain's address-blocked senders too, not just its members", () => {
      const { filters } = compileFilters(
        [sender("solo@shop.test")],
        [
          {
            domain: "shop.test",
            excludeAddresses: manyExceptions,
            blockedMemberAddresses: ["promo@shop.test"],
          },
        ],
        { maxCriteriaChars: 40 },
      );
      // Both are enumerated exactly once — the domain rule that used to cover the
      // address-blocked sender no longer exists.
      expect(filters.map((f) => f.from)).toEqual(["promo@shop.test", "solo@shop.test"]);
    });

    it("reports a dropped block when there is no member list to enumerate from", () => {
      const { filters, exceptionOverflows } = compileFilters(
        [],
        [{ domain: "shop.test", excludeAddresses: manyExceptions }],
        { maxCriteriaChars: 40 },
      );
      // Better no filter than one Gmail rejects on every sync forever — but the caller is
      // told the domain is NOT blocked rather than left to infer it.
      expect(filters).toEqual([]);
      expect(exceptionOverflows).toEqual([
        { domain: "shop.test", strategy: "dropped", exceptionCount: 6 },
      ]);
    });

    it("leaves other domains' filters untouched when one overflows", () => {
      const { filters } = compileFilters(
        [],
        [
          { domain: "a.test" },
          {
            domain: "shop.test",
            excludeAddresses: manyExceptions,
            blockedMemberAddresses: ["promo@shop.test"],
          },
        ],
        { maxCriteriaChars: 40 },
      );
      expect(filters.map((f) => f.from).sort()).toEqual(["*@a.test", "promo@shop.test"]);
    });
  });
});

describe("reconcileFilters", () => {
  const desired: FilterSpec[] = [
    { from: "a@x.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    { from: "b@y.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
  ];

  const asNative = (specs: FilterSpec[]): NativeFilter[] =>
    specs.map((spec, i) => ({ ...spec, id: `f-${i}` }));

  /** All ids from `filters`, i.e. every one of them is app-managed. */
  const allManaged = (filters: NativeFilter[]): Set<string> => new Set(filters.map((f) => f.id));

  it("creates every desired filter against an empty account", () => {
    const plan = reconcileFilters(desired, [], new Set());
    expect(plan.toCreate).toHaveLength(2);
    expect(plan.toDelete).toEqual([]);
  });

  it("is idempotent — no ops once the desired set already exists", () => {
    const existing = asNative(desired);
    const plan = reconcileFilters(desired, existing, allManaged(existing));
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("deletes a managed filter that is no longer desired", () => {
    const existing = asNative([
      ...desired,
      { from: "stale@z.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    const plan = reconcileFilters(desired, existing, allManaged(existing));
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual(["f-2"]);
  });

  it("never touches foreign filters, even ones not tracked as managed", () => {
    const foreign: NativeFilter[] = [
      { id: "foreign", from: "boss@work.test", addLabelIds: ["IMPORTANT"], removeLabelIds: [] },
    ];
    const plan = reconcileFilters([], foreign, new Set());
    expect(plan.toDelete).toEqual([]);
  });

  it("never deletes a foreign filter that merely shares the block action shape (#29)", () => {
    // A hand-built "Trash + skip inbox" filter the user made themselves — never
    // created via `createFilter`, so its id was never recorded as managed.
    const handMade: NativeFilter[] = [
      {
        id: "hand-made",
        from: "oldjob@company.test",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ];
    const plan = reconcileFilters([], handMade, new Set());
    expect(plan.toDelete).toEqual([]);
  });

  it("creates the missing and deletes the stale in one pass", () => {
    const existing = asNative([
      { from: "b@y.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      { from: "old@z.test", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    const plan = reconcileFilters(desired, existing, allManaged(existing));
    expect(plan.toCreate.map((f) => f.from)).toEqual(["a@x.test"]);
    expect(plan.toDelete).toEqual(["f-1"]);
  });

  it("surfaces an untracked filter matching a desired one as adoptable instead of duplicating it (#80)", () => {
    const untracked: NativeFilter = {
      id: "hand-made",
      from: "a@x.test",
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX"],
    };
    const plan = reconcileFilters(desired, [untracked], new Set());
    expect(plan.toCreate.map((f) => f.from)).toEqual(["b@y.test"]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.adoptable).toEqual([untracked]);
  });

  it("does not surface a managed filter as adoptable — it is already tracked", () => {
    const existing = asNative(desired);
    const plan = reconcileFilters(desired, existing, allManaged(existing));
    expect(plan.adoptable).toEqual([]);
  });

  it("never adopts a filter that also matches on criteria we cannot see (#212)", () => {
    // Signs identically to the desired block, but Gmail is also matching a subject — so it
    // blocks a fraction of that sender's mail, not the sender. Adopting it would record a
    // rule we don't understand as ours, and report the sender as fully blocked.
    const target = desired[0] as FilterSpec;
    const narrower: NativeFilter = {
      id: "narrower",
      from: target.from,
      addLabelIds: target.addLabelIds,
      removeLabelIds: target.removeLabelIds,
      unmodelledCriteria: ["subject"],
    };

    const plan = reconcileFilters(desired, [narrower], new Set());

    expect(plan.adoptable).toEqual([]);
    // …and the desired filter is still wanted: the lookalike does not stand in for it.
    expect(plan.toCreate.map((f) => f.from)).toContain(desired[0]?.from);
  });

  it("never deletes a filter carrying criteria we cannot see, even if tracked (#212)", () => {
    // The app only ever creates filters from a FilterSpec, so this cannot be one of ours —
    // whatever managedFilterIds says (an earlier adoption, say). Provenance by construction.
    const foreign: NativeFilter = {
      id: "foreign",
      from: "someone@x.test",
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX"],
      unmodelledCriteria: ["query"],
    };

    const plan = reconcileFilters([], [foreign], new Set(["foreign"]));

    expect(plan.toDelete).toEqual([]);
  });

  it("does not surface a foreign filter with no matching desired criteria as adoptable", () => {
    const foreign: NativeFilter = {
      id: "foreign",
      from: "boss@work.test",
      addLabelIds: ["IMPORTANT"],
      removeLabelIds: [],
    };
    const plan = reconcileFilters(desired, [foreign], new Set());
    expect(plan.adoptable).toEqual([]);
  });

  it("disowns a managed filter that gains unmodelled criteria, without deleting it (#232)", () => {
    // The app created this as a plain block on a@x.test; the user then hand-edited it in
    // Gmail's UI to also match on subject. It's no longer comparable, so it drops out of
    // every matching decision — but it must also stop being claimed as managed, or its id
    // sits in managedFilterIds forever with no code path able to act on it.
    const handEdited: NativeFilter = {
      id: "f-0",
      from: "a@x.test",
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX"],
      unmodelledCriteria: ["subject"],
    };
    const plan = reconcileFilters(desired, [handEdited], new Set(["f-0"]));

    expect(plan.disowned).toEqual(["f-0"]);
    expect(plan.toDelete).toEqual([]);
    // The desired filter it used to satisfy is wanted again — it's no longer covered.
    expect(plan.toCreate.map((f) => f.from)).toContain(desired[0]?.from);
  });

  it("does not reintroduce a disowned id on a second reconcile (idempotent)", () => {
    const handEdited: NativeFilter = {
      id: "f-0",
      from: "a@x.test",
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX"],
      unmodelledCriteria: ["subject"],
    };
    // Second pass runs with the id already dropped from managedFilterIds, as the caller
    // would persist after applying the first plan's `disowned`.
    const plan = reconcileFilters(desired, [handEdited], new Set());

    expect(plan.disowned).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("keeps a still-comparable managed filter's id — no regression on the normal path", () => {
    const existing = asNative(desired);
    const plan = reconcileFilters(desired, existing, allManaged(existing));
    expect(plan.disowned).toEqual([]);
  });

  it("does not report a managed id whose filter no longer exists as disowned", () => {
    // The existing "does it still exist?" prune (in reconcileNativeFilters) handles this
    // case by dropping the id from managedFilterIds before calling reconcileFilters — so
    // by the time reconcileFilters runs, a gone filter's id is simply absent from both
    // `existing` and `managedFilterIds`, never surfaced here as disowned.
    const plan = reconcileFilters(desired, [], new Set(["gone"]));
    expect(plan.disowned).toEqual([]);
  });
});
