// SPDX-License-Identifier: Apache-2.0
import { useLayout, type LayoutPref } from "../../layout/context";

const OPTIONS: { id: LayoutPref; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "desktop", label: "Desktop" },
  { id: "mobile", label: "Mobile" },
];

/**
 * Segmented control to pin the layout (Auto / Desktop / Mobile). Auto follows the device
 * breakpoint; pinning is remembered on-device. Lives in the account area of both shells.
 */
export function LayoutSwitch({ className = "" }: { className?: string }) {
  const { pref, setPref } = useLayout();
  return (
    <fieldset className={`flex items-center gap-2 ${className}`}>
      <legend className="sr-only">Layout mode</legend>
      <span className="text-xs text-muted">Layout</span>
      <div className="inline-flex rounded-md border border-line p-0.5" role="group">
        {OPTIONS.map((option) => {
          const active = pref === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => setPref(option.id)}
              className={`min-h-9 rounded px-3 text-xs font-medium transition-colors ${
                active ? "bg-ink text-bg" : "text-muted hover:bg-surface-2"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
