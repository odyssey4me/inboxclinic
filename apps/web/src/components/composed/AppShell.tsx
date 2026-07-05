// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";

import { Button } from "../ui/Button";
import { Footer } from "./Footer";

/** Views reachable from the primary nav. `App`'s View union may include more (e.g. the
 *  workflow sub-flow), which simply leaves no tab highlighted. */
export type ShellView = "dashboard" | "analytics" | "settings";

export interface AppShellProps {
  email: string;
  online: boolean;
  /** Current view — used to highlight the active nav tab. */
  view: string;
  onNavigate: (view: ShellView) => void;
  onSync: () => void;
  onScan: () => void;
  syncing: boolean;
  scanning: boolean;
  error: string | null;
  children: ReactNode;
}

const NAV: { id: ShellView; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "analytics", label: "Analytics" },
  { id: "settings", label: "Settings" },
];

const OFFLINE_NOTICE = "Offline — Gmail sync paused; local data is available.";

/**
 * Persistent application shell for signed-in views (design-frontend.md — Application
 * shell & navigation): a fixed header with the brand, the signed-in account, primary
 * navigation, and the global Sync/Scan actions, wrapping a swappable content area and the
 * footer. Screens render content only.
 */
export function AppShell({
  email,
  online,
  view,
  onNavigate,
  onSync,
  onScan,
  syncing,
  scanning,
  error,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      {!online && (
        <p role="status" className="bg-amber-50 px-4 py-2 text-center text-sm text-amber-700">
          {OFFLINE_NOTICE}
        </p>
      )}

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="shrink-0 text-xl font-bold tracking-tight">
              <button
                type="button"
                onClick={() => onNavigate("dashboard")}
                className="text-slate-900"
              >
                Inbox Clinic
              </button>
            </h1>
            <span className="truncate text-sm text-slate-500">
              <span className="hidden sm:inline">Signed in as </span>
              <span className="font-medium text-slate-700">{email}</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <nav className="flex items-center gap-1" aria-label="Primary">
              {NAV.map((item) => {
                const active = view === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
            <span
              className="mx-1 hidden h-5 w-px bg-slate-200 sm:inline-block"
              aria-hidden="true"
            />
            <Button variant="secondary" onClick={onSync} disabled={syncing || !online}>
              {syncing ? "Syncing…" : "Sync"}
            </Button>
            <Button variant="secondary" onClick={onScan} disabled={scanning || !online}>
              {scanning ? "Scanning…" : "Scan"}
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      {error !== null && (
        <p role="alert" className="px-4 pb-4 text-center text-sm text-red-600">
          {error}
        </p>
      )}
      <Footer />
    </div>
  );
}
