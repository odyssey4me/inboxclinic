// SPDX-License-Identifier: Apache-2.0
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { publicSuffix, registrableDomain, sameRegistrableDomain } from "./registrableDomain";

// The eTLD+1 grouping decides which senders one parent-domain rule covers, so a wrong
// grouping either leaks (a sender escapes the rule) or over-reaches (an unrelated
// organisation is caught by it). These properties assert the invariants that must hold for
// ANY hostname, not just the hand-picked ones. See design-trust-decisions.md Decision 9.

/** Hostnames built from a label + a suffix known to the bundled list. */
const SUFFIXES = ["com", "co.uk", "com.au", "org", "github.io", "pages.dev"] as const;
const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
const suffix = fc.constantFrom(...SUFFIXES);

/**
 * A registrable domain: one label above a known public suffix — *filtered to those that
 * really are registrable*. The composition isn't automatically one: `za.com` and `uk.com`
 * are themselves entries in the list, so `"za" + ".com"` yields a bare public suffix that
 * belongs to nobody and has no eTLD+1. Filtering keeps the generator honest instead of
 * asserting a base the list says cannot exist (a genuine flake this suite caught).
 */
const registrable = fc
  .tuple(label, suffix)
  .map(([name, sfx]) => `${name}.${sfx}`)
  .filter((host) => registrableDomain(host) === host);
/** Zero or more subdomain labels under a registrable domain. */
const subdomainOf = (base: string): fc.Arbitrary<string> =>
  fc.array(label, { minLength: 0, maxLength: 3 }).map((parts) => [...parts, base].join("."));

describe("registrableDomain (properties)", () => {
  it("is idempotent — the eTLD+1 of an eTLD+1 is itself", () => {
    fc.assert(
      fc.property(registrable, (host) => {
        const once = registrableDomain(host);
        expect(once).not.toBeNull();
        expect(registrableDomain(once as string)).toBe(once);
      }),
    );
  });

  it("collapses every subdomain of a domain onto that domain", () => {
    fc.assert(
      fc.property(
        registrable.chain((base) => fc.tuple(fc.constant(base), subdomainOf(base))),
        ([base, host]) => {
          expect(registrableDomain(host)).toBe(base);
          expect(sameRegistrableDomain(host, base)).toBe(true);
        },
      ),
    );
  });

  it("never groups two different registrable domains, however deep their subdomains", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(registrable, registrable)
          .chain(([a, b]) =>
            fc.tuple(fc.constant(a), fc.constant(b), subdomainOf(a), subdomainOf(b)),
          ),
        ([a, b, hostA, hostB]) => {
          fc.pre(a !== b);
          expect(sameRegistrableDomain(hostA, hostB)).toBe(false);
        },
      ),
    );
  });

  it("is a suffix of the host it came from, on label boundaries", () => {
    fc.assert(
      fc.property(
        registrable.chain((base) => subdomainOf(base)),
        (host) => {
          const etld1 = registrableDomain(host);
          expect(etld1).not.toBeNull();
          // Either the host IS the registrable domain, or it ends with `.<registrable domain>` —
          // never a partial-label match (`notapple.com` must not reduce to `apple.com`).
          expect(host === etld1 || host.endsWith(`.${etld1 as string}`)).toBe(true);
        },
      ),
    );
  });

  it("leaves the public suffix outside the registrable domain's own label", () => {
    fc.assert(
      fc.property(fc.tuple(registrable, suffix), ([host, sfx]) => {
        expect(registrableDomain(host)).toBe(host);
        // The suffix alone carries no registrable domain — it belongs to nobody.
        expect(registrableDomain(sfx)).toBeNull();
        // …and the host keeps its suffix as a trailing, label-aligned part.
        const hostSuffix = publicSuffix(host);
        expect(hostSuffix).not.toBeNull();
        expect(host.endsWith(`.${hostSuffix as string}`)).toBe(true);
      }),
    );
  });

  it("is case-insensitive across a hostname's labels", () => {
    // Case-folding is exercised over ASCII hostnames only: `toUpperCase()` is not
    // invertible for every character (ß → SS, ı → I), so folding arbitrary Unicode would
    // test JS casing rather than this helper.
    fc.assert(
      fc.property(
        registrable.chain((base) => subdomainOf(base)),
        (host) => {
          expect(registrableDomain(host.toUpperCase())).toBe(registrableDomain(host));
        },
      ),
    );
  });

  it("normalises surrounding whitespace, and never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), fc.stringMatching(/^[ \t\n]{0,4}$/), (raw, pad) => {
        expect(registrableDomain(`${pad}${raw}${pad}`)).toBe(
          registrableDomain(raw.trim().toLowerCase()),
        );
      }),
    );
  });

  it("returns null rather than a guess for arbitrary non-hostname input", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = registrableDomain(raw);
        // Whatever comes back is either null or a string containing a dot — the helper never
        // invents a single-label "domain" a rule could be built on.
        expect(result === null || result.includes(".")).toBe(true);
      }),
    );
  });
});
