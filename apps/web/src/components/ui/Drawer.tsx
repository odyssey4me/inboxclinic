// SPDX-License-Identifier: Apache-2.0
import { useEffect, type ReactNode } from "react";

import { Button } from "./Button";

export interface DrawerProps {
  /** Accessible dialog label (e.g. "Actions for news@retailco.com"). */
  label: string;
  /** Visible header title (e.g. "Sender", "Domain"). */
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A modal detail drawer — a right-side panel on desktop, a bottom sheet on mobile.
 * Owns the overlay, Escape / backdrop-click dismissal, and the labelled dialog header;
 * callers supply the body (e.g. SenderDetail, DomainDetail, the global feedback panel).
 */
export function Drawer({ label, title, onClose, children }: DrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-end bg-ink/40 sm:items-stretch sm:justify-end"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="max-h-[88vh] w-full space-y-4 overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-lg sm:h-full sm:max-h-none sm:w-96 sm:rounded-none"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}
