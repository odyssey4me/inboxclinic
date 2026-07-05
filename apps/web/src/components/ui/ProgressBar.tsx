// SPDX-License-Identifier: Apache-2.0

/** Semantic fill colour — `accent` (default) plus the decision/health tones. */
export type BarTone = "accent" | "trust" | "defer" | "block";

const FILL: Record<BarTone, string> = {
  accent: "bg-accent",
  trust: "bg-trust",
  defer: "bg-defer",
  block: "bg-block",
};

const TRACK: Record<BarTone, string> = {
  accent: "bg-accent/15",
  trust: "bg-trust/15",
  defer: "bg-defer/15",
  block: "bg-block/15",
};

export interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
  /** Fill colour; defaults to the brand accent. Use a health/decision tone to encode state. */
  tone?: BarTone;
}

/** Accessible progress bar (announced via role + aria values). */
export function ProgressBar({ value, max, label, tone = "accent" }: ProgressBarProps) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label ?? "Progress"}
      className={`h-2 w-full overflow-hidden rounded-full ${TRACK[tone]}`}
    >
      <div
        className={`h-full rounded-full transition-all ${FILL[tone]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
