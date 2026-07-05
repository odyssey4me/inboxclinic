// SPDX-License-Identifier: Apache-2.0
import type { HTMLAttributes } from "react";

/** Simple surface container. */
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`}
      {...props}
    />
  );
}
