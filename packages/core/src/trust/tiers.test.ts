// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { trustTier } from "./tiers";

describe("trustTier", () => {
  it("maps the Highly Trusted band (+7..+10) to green", () => {
    expect(trustTier(7)).toEqual({ tier: "Highly Trusted", colour: "green" });
    expect(trustTier(10)).toEqual({ tier: "Highly Trusted", colour: "green" });
  });

  it("maps the Generally Trusted band (+3..+6) to light-green", () => {
    expect(trustTier(3)).toEqual({ tier: "Generally Trusted", colour: "light-green" });
    expect(trustTier(6)).toEqual({ tier: "Generally Trusted", colour: "light-green" });
  });

  it("maps the Mixed band (-2..+2) to grey", () => {
    expect(trustTier(2)).toEqual({ tier: "Mixed", colour: "grey" });
    expect(trustTier(0)).toEqual({ tier: "Mixed", colour: "grey" });
    expect(trustTier(-2)).toEqual({ tier: "Mixed", colour: "grey" });
  });

  it("maps the Questionable band (-6..-3) to orange", () => {
    expect(trustTier(-3)).toEqual({ tier: "Questionable", colour: "orange" });
    expect(trustTier(-6)).toEqual({ tier: "Questionable", colour: "orange" });
  });

  it("maps the Widely Distrusted band (-10..-7) to red", () => {
    expect(trustTier(-7)).toEqual({ tier: "Widely Distrusted", colour: "red" });
    expect(trustTier(-10)).toEqual({ tier: "Widely Distrusted", colour: "red" });
  });

  it("clamps out-of-range scores before tiering", () => {
    expect(trustTier(42)).toEqual({ tier: "Highly Trusted", colour: "green" });
    expect(trustTier(-99)).toEqual({ tier: "Widely Distrusted", colour: "red" });
  });
});
