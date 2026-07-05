/**
 * Trust-tier display mapping.
 *
 * See docs/design-trust-decisions.md ("Trust tiers (display)"): a clamped trust
 * score (-10..+10) maps to a named display tier and colour. These are the
 * display buckets only; the scoring algorithm itself lives elsewhere in core.
 */

export type TrustTierName =
  "Highly Trusted" | "Generally Trusted" | "Mixed" | "Questionable" | "Widely Distrusted";

export type TrustTierColour = "green" | "light-green" | "grey" | "orange" | "red";

export interface TrustTier {
  tier: TrustTierName;
  colour: TrustTierColour;
}

const MIN_SCORE = -10;
const MAX_SCORE = 10;

/**
 * Map a trust score to its display tier and colour.
 *
 * The score is clamped to -10..+10 before bucketing:
 * - +7..+10 → Highly Trusted (green)
 * - +3..+6 → Generally Trusted (light-green)
 * - -2..+2 → Mixed (grey)
 * - -6..-3 → Questionable (orange)
 * - -10..-7 → Widely Distrusted (red)
 */
export function trustTier(score: number): TrustTier {
  const clamped = Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));

  if (clamped >= 7) return { tier: "Highly Trusted", colour: "green" };
  if (clamped >= 3) return { tier: "Generally Trusted", colour: "light-green" };
  if (clamped >= -2) return { tier: "Mixed", colour: "grey" };
  if (clamped >= -6) return { tier: "Questionable", colour: "orange" };
  return { tier: "Widely Distrusted", colour: "red" };
}
