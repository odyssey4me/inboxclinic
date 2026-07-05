// SPDX-License-Identifier: Apache-2.0
export interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
}

/** Accessible progress bar (announced via role + aria values). */
export function ProgressBar({ value, max, label }: ProgressBarProps) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label ?? "Progress"}
      className="h-2 w-full overflow-hidden rounded-full bg-accent/15"
    >
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}
