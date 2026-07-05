// SPDX-License-Identifier: Apache-2.0
import type { HTMLAttributes } from "react";

type Tone = "neutral" | "green" | "red" | "amber" | "blue";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  green: "bg-trust/15 text-trust",
  red: "bg-block/15 text-block",
  amber: "bg-defer/15 text-defer",
  blue: "bg-accent/15 text-accent",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

/** A small text label; colour is always paired with its text content (a11y). */
export function Badge({ tone = "neutral", className = "", ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
      {...props}
    />
  );
}
