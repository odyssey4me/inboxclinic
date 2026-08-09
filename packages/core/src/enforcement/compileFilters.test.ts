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
    const { filters } = compileFilters([sender("spam@a.com")], []);
    expect(filters).toEqual([
      { from: "spam@a.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("aggregates to one *@domain filter once 3+ senders of a domain are blocked", () => {
    const { filters } = compileFilters(
      [sender("a@x.com"), sender("b@x.com"), sender("c@x.com")],
      [],
    );
    expect(filters).toEqual([
      { from: "*@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("keeps per-address filters below the domain threshold (2 senders)", () => {
    const { filters } = compileFilters([sender("a@x.com"), sender("b@x.com")], []);
    expect(filters.map((f) => f.from)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("treats an explicitly blocked domain as aggregated regardless of sender count", () => {
    const { filters } = compileFilters([sender("a@x.com")], [{ domain: "x.com" }]);
    expect(filters).toEqual([
      { from: "*@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("carves exception addresses out of a domain filter via excludeFrom, sorted (#145)", () => {
    const { filters } = compileFilters(
      [],
      [{ domain: "shop.com", excludeAddresses: ["vip@shop.com", "boss@shop.com"] }],
    );
    expect(filters).toEqual<FilterSpec[]>([
      {
        from: "*@shop.com",
        excludeFrom: "boss@shop.com OR vip@shop.com",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ]);
  });

  it("gives an exception-carrying domain its own filter, and covers the plain domains (#145)", () => {
    const { filters } = compileFilters(
      [],
      [
        { domain: "a.com" },
        { domain: "b.com" },
        { domain: "c.com", excludeAddresses: ["vip@c.com"] },
      ],
    );
    // The exception-carrying domain always gets its OWN filter (an OR-group can't share one exclusion).
    expect(filters.find((f) => f.from === "*@c.com")?.excludeFrom).toBe("vip@c.com");
    // The plain domains are each covered exactly once, never folded into the exception filter.
    expect(plainDomainsCovered(filters)).toEqual(["a.com", "b.com"]);
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
    const domains = [{ domain: "a.com" }, { domain: "b.com" }, { domain: "c.com" }];
    const { filters } = compileFilters([], domains, { maxDomainsPerFilter: 2 });
    for (const f of filters) expect(f.from.split(" OR ").length).toBeLessThanOrEqual(2);
    expect(plainDomainsCovered(filters)).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("degrades to one domain per filter at maxDomainsPerFilter=1 (#152)", () => {
    const domains = [{ domain: "a.com" }, { domain: "b.com" }, { domain: "c.com" }];
    const { filters } = compileFilters([], domains, { maxDomainsPerFilter: 1 });
    expect(filters.map((f) => f.from).sort()).toEqual(["*@a.com", "*@b.com", "*@c.com"]);
  });

  it("keeps unrelated domains' filters stable when one domain is added (#152)", () => {
    const base = Array.from({ length: 40 }, (_, i) => ({
      domain: `d${String(i).padStart(2, "0")}.com`,
    }));
    const before = compileFilters([], base).filters.map((f) => f.from);
    // Insert one new domain that sorts to the very front.
    const after = compileFilters([], [{ domain: "aaa-new.com" }, ...base]).filters.map(
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
    const result = compileFilters([sender("a@a.com")], []);
    expect(result.capReached).toBe(false);
    expect(result.skippedAtCap).toBe(0);
  });

  it("prefers domain aggregation first when the cap bites", () => {
    const senders = [
      sender("a@agg.com"),
      sender("b@agg.com"),
      sender("c@agg.com"),
      sender("solo@other.com"),
    ];
    const { filters } = compileFilters(senders, [], { softCap: 1 });
    expect(filters).toEqual([
      { from: "*@agg.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
  });

  it("deduplicates and lowercases sender addresses", () => {
    const { filters } = compileFilters([sender("Dup@X.com"), sender("dup@x.com")], []);
    expect(filters.map((f) => f.from)).toEqual(["dup@x.com"]);
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
    const manyExceptions = Array.from({ length: 6 }, (_, i) => `vip${i}@shop.com`);

    it("keeps the single carve-out filter while the criteria fit", () => {
      const { filters, exceptionOverflows } = compileFilters(
        [],
        [{ domain: "shop.com", excludeAddresses: manyExceptions }],
      );
      expect(exceptionOverflows).toEqual([]);
      expect(filters).toHaveLength(1);
      expect(filters[0]?.excludeFrom).toBe(manyExceptions.join(" OR "));
    });

    it("counts the query wrapper the adapter adds around the exclusion (#191)", () => {
      // The adapter sends `negatedQuery: from:(<addresses>)`, so the wrapper's 7 characters
      // are part of the criteria. Budget = from + wrapper + addresses exactly, so one char
      // less must overflow — measuring the bare address list would call this a fit.
      const domain = "shop.com";
      const addresses = ["a@shop.com", "b@shop.com"];
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

    it("degrades to one filter per still-blocked member when the carve-out won't fit", () => {
      const { filters, exceptionOverflows } = compileFilters(
        [],
        [
          {
            domain: "shop.com",
            excludeAddresses: manyExceptions,
            blockedMemberAddresses: ["promo@shop.com", "deals@shop.com", "vip0@shop.com"],
          },
        ],
        { maxCriteriaChars: 40 },
      );

      // No `*@shop.com` rule — a plain one would trash exactly the addresses being excepted.
      expect(filters.map((f) => f.from)).toEqual(["deals@shop.com", "promo@shop.com"]);
      expect(filters.every((f) => f.excludeFrom === undefined)).toBe(true);
      expect(exceptionOverflows).toEqual([
        { domain: "shop.com", strategy: "enumerate", exceptionCount: 6 },
      ]);
    });

    it("enumerates a domain's address-blocked senders too, not just its members", () => {
      const { filters } = compileFilters(
        [sender("solo@shop.com")],
        [
          {
            domain: "shop.com",
            excludeAddresses: manyExceptions,
            blockedMemberAddresses: ["promo@shop.com"],
          },
        ],
        { maxCriteriaChars: 40 },
      );
      // Both are enumerated exactly once — the domain rule that used to cover the
      // address-blocked sender no longer exists.
      expect(filters.map((f) => f.from)).toEqual(["promo@shop.com", "solo@shop.com"]);
    });

    it("reports a dropped block when there is no member list to enumerate from", () => {
      const { filters, exceptionOverflows } = compileFilters(
        [],
        [{ domain: "shop.com", excludeAddresses: manyExceptions }],
        { maxCriteriaChars: 40 },
      );
      // Better no filter than one Gmail rejects on every sync forever — but the caller is
      // told the domain is NOT blocked rather than left to infer it.
      expect(filters).toEqual([]);
      expect(exceptionOverflows).toEqual([
        { domain: "shop.com", strategy: "dropped", exceptionCount: 6 },
      ]);
    });

    it("leaves other domains' filters untouched when one overflows", () => {
      const { filters } = compileFilters(
        [],
        [
          { domain: "a.com" },
          {
            domain: "shop.com",
            excludeAddresses: manyExceptions,
            blockedMemberAddresses: ["promo@shop.com"],
          },
        ],
        { maxCriteriaChars: 40 },
      );
      expect(filters.map((f) => f.from).sort()).toEqual(["*@a.com", "promo@shop.com"]);
    });
  });
});

describe("reconcileFilters", () => {
  const desired: FilterSpec[] = [
    { from: "a@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    { from: "b@y.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
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
      { from: "stale@z.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    const plan = reconcileFilters(desired, existing, allManaged(existing));
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual(["f-2"]);
  });

  it("never touches foreign filters, even ones not tracked as managed", () => {
    const foreign: NativeFilter[] = [
      { id: "foreign", from: "boss@work.com", addLabelIds: ["IMPORTANT"], removeLabelIds: [] },
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
        from: "oldjob@company.com",
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"],
      },
    ];
    const plan = reconcileFilters([], handMade, new Set());
    expect(plan.toDelete).toEqual([]);
  });

  it("creates the missing and deletes the stale in one pass", () => {
    const existing = asNative([
      { from: "b@y.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      { from: "old@z.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    const plan = reconcileFilters(desired, existing, allManaged(existing));
    expect(plan.toCreate.map((f) => f.from)).toEqual(["a@x.com"]);
    expect(plan.toDelete).toEqual(["f-1"]);
  });

  it("surfaces an untracked filter matching a desired one as adoptable instead of duplicating it (#80)", () => {
    const untracked: NativeFilter = {
      id: "hand-made",
      from: "a@x.com",
      addLabelIds: ["TRASH"],
      removeLabelIds: ["INBOX"],
    };
    const plan = reconcileFilters(desired, [untracked], new Set());
    expect(plan.toCreate.map((f) => f.from)).toEqual(["b@y.com"]);
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
      from: "someone@x.com",
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
      from: "boss@work.com",
      addLabelIds: ["IMPORTANT"],
      removeLabelIds: [],
    };
    const plan = reconcileFilters(desired, [foreign], new Set());
    expect(plan.adoptable).toEqual([]);
  });
});
