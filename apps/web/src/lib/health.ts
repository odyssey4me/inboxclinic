// SPDX-License-Identifier: Apache-2.0
import type { BadgeTone } from "../components/ui/Badge";
import type { BarTone } from "../components/ui/ProgressBar";

/** Presentation for an inbox-health score: a status label plus the badge/bar tones. */
export interface HealthTone {
  label: string;
  badge: BadgeTone;
  bar: BarTone;
}

/**
 * Map a 0–100 inbox-health score to its presentation. Shared by the Dashboard hero and
 * the Analytics health card so the thresholds and colours stay in one place.
 */
export function healthTone(score: number): HealthTone {
  if (score >= 80) return { label: "Healthy", badge: "green", bar: "trust" };
  if (score >= 50) return { label: "Fair", badge: "amber", bar: "defer" };
  return { label: "Needs attention", badge: "red", bar: "block" };
}
