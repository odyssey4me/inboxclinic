// SPDX-License-Identifier: Apache-2.0
/**
 * Registrable-domain (eTLD+1) helpers — design-trust-decisions.md Decision 9 (#136), the
 * foundation for parent-domain rules (#183).
 *
 * **Why a Public Suffix List and not string splitting.** The registrable domain is *not*
 * "the last two labels": `foo.co.uk`, `x.github.io` and `y.pages.dev` would group
 * catastrophically wrong, lumping every unrelated tenant of a public suffix together as one
 * organisation. These wrap **`tldts`**, whose PSL is bundled and evaluated offline — no
 * network lookup, preserving the client-only invariant (architecture.md §1, §2).
 *
 * Pure and provider-agnostic: string in, string out, no I/O and no DOM.
 *
 * **Maintenance:** the list ships at `tldts`'s release cadence, so a brand-new public suffix
 * isn't recognised until the dependency is bumped (Renovate keeps it current). A stale list
 * only mis-groups a just-created suffix.
 */

import { getDomain, getPublicSuffix } from "tldts";

/**
 * Options shared by the helpers.
 *
 * **`allowPrivateDomains` is load-bearing, not a tweak.** `tldts` defaults it to `false`,
 * which consults only the PSL's ICANN section — so `x.github.io` resolves to `github.io` and
 * every unrelated tenant of a hosting suffix is grouped as one organisation. That is exactly
 * the failure Decision 9 cites (`x.github.io`, `y.pages.dev`) and exactly what a parent-domain
 * rule must never do: one user's block would cover every other tenant. With the PRIVATE
 * section enabled, `x.github.io` is its own registrable domain, as it should be.
 *
 * `extractHostname: false` says the input is already a hostname (a sender's domain), not a URL
 * to parse one out of.
 */
const TLDTS_OPTIONS = { allowPrivateDomains: true, extractHostname: false } as const;

/**
 * The registrable domain (eTLD+1) of a hostname — `news.example.co.uk` → `example.co.uk`.
 *
 * Returns `null` when there is no registrable domain to speak of: a bare public suffix
 * (`co.uk`, `github.io`), an unlisted or malformed host, an IP address, or an empty string.
 * A `null` means "this host cannot carry a parent-domain rule" — callers must not fall back
 * to splitting the string themselves, which is the failure mode this exists to prevent.
 */
export function registrableDomain(host: string): string | null {
  const normalised = host.trim().toLowerCase();
  if (normalised === "") return null;
  return getDomain(normalised, TLDTS_OPTIONS);
}

/**
 * The public suffix of a hostname — `example.co.uk` → `co.uk`, `x.github.io` → `github.io`.
 *
 * Returns `null` for input with no suffix in the list (an IP address, a bare label, or a
 * malformed host). Exported for the broader TLD/public-suffix scope (#180), which ranks
 * below parent-domain on the same specificity ladder; `tldts` serves both, so that scope
 * adds no new dependency.
 */
export function publicSuffix(host: string): string | null {
  const normalised = host.trim().toLowerCase();
  if (normalised === "") return null;
  return getPublicSuffix(normalised, TLDTS_OPTIONS);
}

/**
 * Whether two hostnames belong to the same registrable domain — the membership test a
 * parent-domain rule applies to decide which senders it covers.
 *
 * Both hosts must resolve to a registrable domain: two hosts that are each *only* a public
 * suffix (or otherwise unresolvable) are never "the same organisation", however identical
 * their strings, since a shared public suffix is precisely what does NOT imply shared
 * ownership.
 */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const left = registrableDomain(a);
  if (left === null) return false;
  return left === registrableDomain(b);
}
