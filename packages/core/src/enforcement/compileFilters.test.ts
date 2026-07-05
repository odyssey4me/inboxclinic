// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { compileFilters, reconcileFilters, DEFAULT_FILTER_SOFT_CAP } from "./compileFilters";
import type { FilterSpec, NativeFilter } from "../ports/GmailClient";

const sender = (email: string): { email: string; domain: string } => ({
  email,
  domain: email.split("@")[1] ?? "example.com",
});

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

  it("OR-combines up to 10 domains per filter and splits the overflow", () => {
    const domains = Array.from({ length: 12 }, (_, i) => ({ domain: `d${i}.com` }));
    const { filters } = compileFilters([], domains);
    expect(filters).toHaveLength(2);
    expect(filters[0]?.from.split(" OR ")).toHaveLength(10);
    expect(filters[1]?.from.split(" OR ")).toHaveLength(2);
    expect(filters[0]?.from).toContain("*@d0.com");
  });

  it("respects maxDomainsPerFilter override", () => {
    const domains = [{ domain: "a.com" }, { domain: "b.com" }, { domain: "c.com" }];
    const { filters } = compileFilters([], domains, { maxDomainsPerFilter: 2 });
    expect(filters).toHaveLength(2);
    expect(filters[0]?.from).toBe("*@a.com OR *@b.com");
    expect(filters[1]?.from).toBe("*@c.com");
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
});

describe("reconcileFilters", () => {
  const desired: FilterSpec[] = [
    { from: "a@x.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    { from: "b@y.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
  ];

  const asNative = (specs: FilterSpec[]): NativeFilter[] =>
    specs.map((spec, i) => ({ ...spec, id: `f-${i}` }));

  it("creates every desired filter against an empty account", () => {
    const plan = reconcileFilters(desired, []);
    expect(plan.toCreate).toHaveLength(2);
    expect(plan.toDelete).toEqual([]);
  });

  it("is idempotent — no ops once the desired set already exists", () => {
    const plan = reconcileFilters(desired, asNative(desired));
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("deletes a managed filter that is no longer desired", () => {
    const existing = asNative([
      ...desired,
      { from: "stale@z.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    const plan = reconcileFilters(desired, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toDelete).toEqual(["f-2"]);
  });

  it("never touches foreign (non-managed) filters", () => {
    const foreign: NativeFilter[] = [
      { id: "foreign", from: "boss@work.com", addLabelIds: ["IMPORTANT"], removeLabelIds: [] },
    ];
    const plan = reconcileFilters([], foreign);
    expect(plan.toDelete).toEqual([]);
  });

  it("creates the missing and deletes the stale in one pass", () => {
    const existing = asNative([
      { from: "b@y.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
      { from: "old@z.com", addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ]);
    const plan = reconcileFilters(desired, existing);
    expect(plan.toCreate.map((f) => f.from)).toEqual(["a@x.com"]);
    expect(plan.toDelete).toEqual(["f-1"]);
  });
});
