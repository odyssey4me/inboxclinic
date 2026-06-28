import { describe, expect, it } from "vitest";

import { resolveEffectiveDecision } from "./resolveEffectiveDecision";

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
