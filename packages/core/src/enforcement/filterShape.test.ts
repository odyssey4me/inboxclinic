// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { unwrapExcludeFrom } from "./filterShape";

// The round-trip is load-bearing (#216): a `negatedQuery` this can't recover is a filter
// whose reconcile signature won't match its `FilterSpec`, which is churn on every sync.

describe("unwrapExcludeFrom", () => {
  it("strips the from:(...) wrapper around a single address", () => {
    expect(unwrapExcludeFrom("from:(vip@shop.com)")).toBe("vip@shop.com");
  });

  it("strips the wrapper around an OR-combined exclusion", () => {
    expect(unwrapExcludeFrom("from:(a@x.com OR b@x.com)")).toBe("a@x.com OR b@x.com");
  });

  it("passes an undefined negatedQuery through unchanged", () => {
    expect(unwrapExcludeFrom(undefined)).toBeUndefined();
  });

  it("returns a value that doesn't match the from:(...) shape unchanged", () => {
    // A foreign filter's negatedQuery can be any Gmail query — not necessarily one this
    // port ever wrote. Passing it through, rather than throwing or dropping it, is what
    // lets the caller still see the raw value and reason about it.
    expect(unwrapExcludeFrom("subject:sale")).toBe("subject:sale");
  });

  it("passes the empty string through unchanged, not as undefined", () => {
    // `""` doesn't match `^from:\((.*)\)$`, so it falls through the "unchanged" branch —
    // and callers rely on that: `toNativeFilter` sets `excludeFrom: ""` from it, and the
    // dump this round-trips against must agree, or the replay tests a fiction.
    expect(unwrapExcludeFrom("")).toBe("");
  });

  it("recovers an empty parenthesised exclusion as the empty string", () => {
    expect(unwrapExcludeFrom("from:()")).toBe("");
  });

  it("does not unwrap an unbalanced parenthesis", () => {
    expect(unwrapExcludeFrom("from:(a@x.com")).toBe("from:(a@x.com");
  });

  it("does not unwrap a nested from: inside the parentheses", () => {
    // The regex is anchored and greedy, so a nested `from:(...)` is still captured whole —
    // this documents that behaviour rather than asserting a stricter parse nothing needs.
    expect(unwrapExcludeFrom("from:(from:(a@x.com))")).toBe("from:(a@x.com)");
  });

  it("unwraps across embedded newlines", () => {
    // The `s` flag makes `.` match newlines; Gmail's own criteria don't carry them, but a
    // hand-edited filter could, and the shape should still round-trip.
    expect(unwrapExcludeFrom("from:(a@x.com\nOR b@x.com)")).toBe("a@x.com\nOR b@x.com");
  });
});
