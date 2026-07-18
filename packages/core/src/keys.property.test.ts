// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { keyFor } from "./keys";

// keyFor is the record key for senders/domains — a collision would silently merge two
// distinct addresses/domains. These properties assert collision-freedom and the documented
// trim+lowercase normalization over arbitrary strings. See docs/design-local-store-schema.md.

const normalize = (s: string): string => s.trim().toLowerCase();

describe("keyFor (properties)", () => {
  it("is injective on distinct normalized inputs (no collisions)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(normalize(a) !== normalize(b));
        expect(keyFor(a)).not.toBe(keyFor(b));
      }),
    );
  });

  it("is invariant under surrounding whitespace and case", () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ unit: fc.constantFrom(" ", "\t", "\n") }), (s, pad) => {
        // Case-fold with a stable round-trip so no locale-specific edge (ß/İ) confuses the test.
        const folded = normalize(s);
        expect(keyFor(`${pad}${folded}${pad}`)).toBe(keyFor(folded));
      }),
    );
  });

  it("agrees with an explicit normalize-then-encode round-trip", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(keyFor(s)).toBe(keyFor(normalize(s)));
      }),
    );
  });
});
