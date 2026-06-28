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
      className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
    >
      <div
        className="h-full rounded-full bg-emerald-600 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
