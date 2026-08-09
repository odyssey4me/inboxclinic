// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { isMoreSpecific, resolveEffectiveDecision, SCOPE_SPECIFICITY } from "./resolveEffectiveDecision";

describe("resolveEffectiveDecision", () => {
  it("lets a domain decision override an address decision", () => {
    expect(
      resolveEffectiveDecision({
        addressStatus: "trusted",
        addressIsException: false,
        domainStatus: "blocked",
        domainScope: "domain",
      }),
    ).toEqual({ status: "blocked", source: "domain" });
  });

  it("honours an explicit address exception over the domain decision", () => {
    expect(
      resolveEffectiveDecision({
        addressStatus: "trusted",
        addressIsException: true,
        domainStatus: "blocked",
        domainScope: "domain",
      }),
    ).toEqual({ status: "trusted", source: "address" });
  });

  it("falls back to the address decision when there is no domain decision", () => {
    expect(
      resolveEffectiveDecision({
        addressStatus: "blocked",
        addressIsException: false,
        domainStatus: null,
        domainScope: null,
      }),
    ).toEqual({ status: "blocked", source: "address" });
  });

  it("uses the domain decision when the address is undecided", () => {
    expect(
      resolveEffectiveDecision({
        addressStatus: null,
        addressIsException: false,
        domainStatus: "trusted",
        domainScope: "domain",
      }),
    ).toEqual({ status: "trusted", source: "domain" });
  });

  it("returns pending/none when nothing is decided", () => {
    expect(
      resolveEffectiveDecision({
        addressStatus: null,
        addressIsException: false,
        domainStatus: null,
        domainScope: null,
      }),
    ).toEqual({ status: "pending", source: "none" });
  });
});

describe("scope specificity ladder (#183)", () => {
  it("ranks address over domain over parentDomain", () => {
    expect(SCOPE_SPECIFICITY.address).toBeLessThan(SCOPE_SPECIFICITY.domain);
    expect(SCOPE_SPECIFICITY.domain).toBeLessThan(SCOPE_SPECIFICITY.parentDomain);
  });

  it("compares any two scopes by that rank", () => {
    expect(isMoreSpecific("address", "parentDomain")).toBe(true);
    expect(isMoreSpecific("domain", "parentDomain")).toBe(true);
    expect(isMoreSpecific("parentDomain", "domain")).toBe(false);
    // A scope is never more specific than itself — the comparison is strict.
    expect(isMoreSpecific("domain", "domain")).toBe(false);
  });

  it("ranks every scope exactly once, so no two can tie", () => {
    // `Record<DecisionScope, number>` already fails to compile if a scope is missing; this
    // catches the other half — a new scope pasted in with a duplicate rank.
    const ranks = Object.values(SCOPE_SPECIFICITY);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});
