// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { resolveEffectiveDecision } from "./resolveEffectiveDecision";
import type { DecisionScope, TrustStatus } from "../store/types";

// Property-based coverage of the Decision-2 precedence rule (design-trust-decisions.md).
// The input space is tiny, so fast-check densely samples it and asserts the contract laws —
// not a re-implementation of the branch order. See docs/design-testing.md.

const status = fc.constantFrom<TrustStatus>("trusted", "blocked", "pending");
const nullableStatus = fc.option(status, { nil: null });
const scope = fc.option(fc.constantFrom<DecisionScope>("address", "domain", "parentDomain"), {
  nil: null,
});

const decisionInput = fc.record({
  addressStatus: nullableStatus,
  addressIsException: fc.boolean(),
  domainStatus: nullableStatus,
  domainScope: scope,
  parentDomainStatus: nullableStatus,
  parentDomainIsException: fc.boolean(),
});

/**
 * Decision 2's two-level laws describe what happens *within* a subtree no broader rule
 * claims. A parent-domain rule that applies outranks both levels by design (Decision 9), so
 * these properties are stated under its absence rather than weakened to accommodate it.
 */
const unclaimedByParent = (input: {
  parentDomainStatus: TrustStatus | null;
  parentDomainIsException: boolean;
}): boolean => input.parentDomainStatus === null || input.parentDomainIsException;

describe("resolveEffectiveDecision (properties)", () => {
  it("a parent-domain rule wins unless the narrower subject is carved out of it (#184)", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        fc.pre(input.parentDomainStatus !== null && !input.parentDomainIsException);
        const r = resolveEffectiveDecision(input);
        expect(r.status).toBe(input.parentDomainStatus);
        expect(r.source).toBe("parentDomain");
      }),
    );
  });

  it("an exception to the parent leaves the narrower levels to decide (#184)", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        fc.pre(input.parentDomainStatus !== null && input.parentDomainIsException);
        // Whatever it resolves to, it is not the parent's doing — that rule stepped aside.
        const r = resolveEffectiveDecision(input);
        const narrower = resolveEffectiveDecision({ ...input, parentDomainStatus: null });
        expect(r).toEqual(narrower.source === "none" ? r : narrower);
      }),
    );
  });

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
          unclaimedByParent(input) &&
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

  it("a non-domain scope never overrides a present address decision", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        // Only a "domain"-scope decision overrides the address; an "address"/null scope must not.
        fc.pre(
          unclaimedByParent(input) &&
            input.domainScope !== "domain" &&
            input.addressStatus !== null,
        );
        const r = resolveEffectiveDecision(input);
        expect(r.status).toBe(input.addressStatus);
        expect(r.source).toBe("address");
      }),
    );
  });

  it("an exception keeps its own address decision regardless of the domain", () => {
    fc.assert(
      fc.property(decisionInput, (input) => {
        fc.pre(
          unclaimedByParent(input) && input.addressIsException && input.addressStatus !== null,
        );
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
        else if (r.source === "parentDomain") expect(r.status).toBe(input.parentDomainStatus);
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
