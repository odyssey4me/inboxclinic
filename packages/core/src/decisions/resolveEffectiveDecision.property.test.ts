// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { resolveEffectiveDecision } from "./resolveEffectiveDecision";
import type { DecisionScope, TrustStatus } from "../store/types";

// Property-based coverage of the Decision-2 precedence rule (design-trust-decisions.md).
// The input space is tiny, so these exhaustively exercise every combination and assert the
// contract laws — not a re-implementation of the branch order. See docs/design-testing.md.

const status = fc.constantFrom<TrustStatus>("trusted", "blocked", "pending");
const nullableStatus = fc.option(status, { nil: null });
const scope = fc.option(fc.constantFrom<DecisionScope>("address", "domain"), { nil: null });

const decisionInput = fc.record({
  addressStatus: nullableStatus,
  addressIsException: fc.boolean(),
  domainStatus: nullableStatus,
  domainScope: scope,
});

describe("resolveEffectiveDecision (properties)", () => {
  it("is total: always returns a valid TrustStatus, never throws", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        const { status: s } = resolveEffectiveDecision(input);
        expect(["trusted", "blocked", "pending"]).toContain(s);
      }),
    );
  });

  it("a domain-scope decision overrides a non-exception address", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        fc.pre(
          input.domainStatus !== null &&
            input.domainScope === "domain" &&
            !input.addressIsException,
        );
        const r = resolveEffectiveDecision(input);
        expect(r.status).toBe(input.domainStatus);
        expect(r.source).toBe("domain");
      }),
    );
  });

  it("an exception keeps its own address decision regardless of the domain", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        fc.pre(input.addressIsException && input.addressStatus !== null);
        const r = resolveEffectiveDecision(input);
        expect(r.status).toBe(input.addressStatus);
        expect(r.source).toBe("address");
      }),
    );
  });

  it("reports a source consistent with the resolved status", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        const r = resolveEffectiveDecision(input);
        if (r.source === "address") expect(r.status).toBe(input.addressStatus);
        else if (r.source === "domain") expect(r.status).toBe(input.domainStatus);
        else expect(r.status).toBe("pending");
      }),
    );
  });

  it("is deterministic (pure)", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        expect(resolveEffectiveDecision(input)).toEqual(resolveEffectiveDecision(input));
      }),
    );
  });
});
