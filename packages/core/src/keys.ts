/**
 * Stable, collision-free key encoding for senders and domains.
 *
 * See docs/design-local-store-schema.md ("Key encoding"): records are keyed by a
 * URL-safe Base64 (no padding) of the lowercased, trimmed email/domain, so
 * `foo.bar@x.com` and `foo_bar@x.com` never collide.
 */

/** Encode bytes as URL-safe Base64 with no padding. */
function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Derive a stable storage key for an email address or domain.
 *
 * The input is trimmed and lowercased, then encoded as URL-safe Base64 without
 * padding. e.g. `keyFor("Company.com") === "Y29tcGFueS5jb20"`.
 */
export function keyFor(s: string): string {
  const normalised = s.trim().toLowerCase();
  return base64UrlNoPad(new TextEncoder().encode(normalised));
}
