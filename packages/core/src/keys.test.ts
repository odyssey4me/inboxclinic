// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { keyFor } from "./keys";

describe("keyFor", () => {
  it("encodes the lowercased, trimmed input as URL-safe Base64 (no padding)", () => {
    expect(keyFor("Company.test")).toBe("Y29tcGFueS50ZXN0");
  });

  it("normalises case and surrounding whitespace", () => {
    expect(keyFor("  COMPANY.test  ")).toBe(keyFor("company.test"));
  });

  it("does not collide for dotted vs underscored local parts", () => {
    expect(keyFor("foo.bar@x.test")).not.toBe(keyFor("foo_bar@x.test"));
  });

  it("emits no Base64 padding characters", () => {
    expect(keyFor("a-longer-domain-that-would-pad.example.org")).not.toContain("=");
  });

  it("uses URL-safe alphabet (no '+' or '/')", () => {
    // Bytes chosen so standard Base64 would contain '+' and '/'.
    const key = keyFor("ÿÿÿÿ");
    expect(key).not.toMatch(/[+/]/);
  });
});
