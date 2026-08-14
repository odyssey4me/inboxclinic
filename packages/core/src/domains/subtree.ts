// SPDX-License-Identifier: Apache-2.0
/**
 * Label-boundary subtree tests — "is this host under that domain?".
 *
 * Gmail's `from:*@domain` matches the domain **and everything under it**, measured against a
 * real account (#210): `from:*@google.com` returned `docs.`, `accounts.` and `plus.google.com`
 * alongside the apex, and `from:*@monzo.com` reached `customercontent.monzo.com`, two labels
 * deep. Enforcement, the preview, and the in-memory reference client all have to agree on what
 * "under" means, so it is defined once here rather than re-derived at each site.
 *
 * The boundary is a **dot-separated label**, never a substring: `notexample.com` is not under
 * `example.com`, and neither is `example.com.evil.com`. A substring test admits both — the
 * first as a suffix accident, the second as a spoofable one.
 *
 * This is deliberately NOT registrable-domain aware. It answers a question about host
 * structure; whether a rule *should* span the subtree is a decision question, and lives in
 * design-trust-decisions.md.
 *
 * Pure: strings in, boolean out, no PSL lookup and no I/O.
 */

/** Normalise for comparison — hosts are case-insensitive, and a trailing root dot is noise. */
function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Is `host` **strictly below** `domain` — a subdomain of it, but not the domain itself?
 *
 * This is the test for "a separate record the user may have decided about independently".
 */
export function isSubdomainOf(host: string, domain: string): boolean {
  const child = normaliseHost(host);
  const parent = normaliseHost(domain);
  if (child === "" || parent === "" || child === parent) return false;
  return child.endsWith(`.${parent}`);
}

/** Is `host` inside `domain`'s subtree — the domain itself, or anything below it? */
export function inDomainSubtree(host: string, domain: string): boolean {
  return normaliseHost(host) === normaliseHost(domain) || isSubdomainOf(host, domain);
}
