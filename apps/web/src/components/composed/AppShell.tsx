// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";

import { useLayout } from "../../layout/context";
import { relativeTime } from "../../lib/relativeTime";
import { Button } from "../ui/Button";
import { Footer } from "./Footer";
import { LayoutSwitch } from "./LayoutSwitch";

/** Views reachable from the primary nav. `App`'s View union may include more (e.g. the
 *  workflow sub-flow), which simply leaves no tab highlighted. */
export type ShellView = "dashboard" | "decisions" | "analytics" | "settings";

export interface AppShellProps {
  email: string;
  online: boolean;
  /** Current view — used to highlight the active nav tab. */
  view: string;
  onNavigate: (view: ShellView) => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** Epoch ms of the last successful sync/scan, or null before the first. */
  lastSyncedAt: number | null;
  /** One-line result of the most recent refresh (e.g. "3 new senders"), or null. */
  syncSummary: string | null;
  /** Forget the session and return to the landing (local data is kept). */
  onDisconnect: () => void;
  error: string | null;
  /** Demo mode: show the demo banner with an exit action. */
  demo?: boolean;
  onExitDemo?: () => void;
  children: ReactNode;
}

const NAV: { id: ShellView; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "decisions", label: "Decisions" },
  { id: "analytics", label: "Analytics" },
  { id: "settings", label: "Settings" },
];

const OFFLINE_NOTICE = "Offline — Gmail sync paused; local data is available.";

/**
 * Persistent application shell for signed-in views (design-frontend.md — Application
 * shell & navigation). Two structurally distinct layouts share the same props: a
 * touch-first single-column **mobile** shell (top bar) and a **desktop** shell (left
 * sidebar + wide content). The active layout comes from `useLayout`, which the account
 * area lets the user pin. Screens render content only.
 */
export function AppShell(props: AppShellProps) {
  const { layout } = useLayout();
  return layout === "desktop" ? <DesktopShell {...props} /> : <MobileShell {...props} />;
}

function OfflineBanner() {
  return (
    <p role="status" className="bg-defer/10 px-4 py-2 text-center text-sm text-defer">
      {OFFLINE_NOTICE}
    </p>
  );
}

function DemoBanner({ onExit }: { onExit: (() => void) | undefined }) {
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-accent-soft px-4 py-2 text-center text-sm text-accent-ink">
      <span>
        <strong className="font-semibold">Demo mode</strong> — sample data, nothing is sent to
        Google.
      </span>
      {onExit !== undefined && (
        <button type="button" onClick={onExit} className="font-medium underline">
          Exit demo
        </button>
      )}
    </p>
  );
}

function ErrorLine({ error }: { error: string }) {
  return (
    <p role="alert" className="px-4 pb-4 text-center text-sm text-block">
      {error}
    </p>
  );
}

/** The account block shared by both shells' account areas: identity, layout, disconnect. */
function AccountControls({ email, onDisconnect }: { email: string; onDisconnect: () => void }) {
  return (
    <>
      <p className="truncate text-xs text-muted">
        Signed in as <span className="font-medium text-ink">{email}</span>
      </p>
      <LayoutSwitch />
      <button
        type="button"
        onClick={onDisconnect}
        className="block text-left text-xs font-medium text-muted underline-offset-2 hover:text-block hover:underline"
      >
        Disconnect
      </button>
    </>
  );
}

function Brand({ onNavigate }: { onNavigate: (view: ShellView) => void }) {
  return (
    <h1 className="text-xl font-bold tracking-tight">
      <button type="button" onClick={() => onNavigate("dashboard")} className="text-ink">
        Inbox Clinic
      </button>
    </h1>
  );
}

function RefreshControl({
  onRefresh,
  refreshing,
  online,
  lastSyncedAt,
  syncSummary,
}: Pick<AppShellProps, "onRefresh" | "refreshing" | "online" | "lastSyncedAt" | "syncSummary">) {
  const status =
    syncSummary ?? (lastSyncedAt !== null ? `Synced ${relativeTime(lastSyncedAt)}` : null);
  return (
    <div className="flex items-center gap-2">
      {status !== null && (
        <span className="hidden text-xs text-muted sm:inline" aria-live="polite">
          {status}
        </span>
      )}
      <Button variant="secondary" onClick={onRefresh} disabled={refreshing || !online}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </div>
  );
}

// ---- Mobile shell: top bar, single column, touch-first --------------------------------

function MobileShell({
  email,
  online,
  view,
  onNavigate,
  onRefresh,
  refreshing,
  lastSyncedAt,
  syncSummary,
  onDisconnect,
  error,
  demo,
  onExitDemo,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      {demo === true && <DemoBanner onExit={onExitDemo} />}
      {!online && <OfflineBanner />}

      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <Brand onNavigate={onNavigate} />
            <details className="group relative">
              <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-md px-2 text-sm text-muted marker:hidden">
                <span className="max-w-[9rem] truncate font-medium text-ink">{email}</span>
                <span
                  aria-hidden="true"
                  className="ml-1 transition-transform group-open:rotate-180"
                >
                  ▾
                </span>
              </summary>
              <div className="absolute right-0 z-10 mt-1 w-64 space-y-3 rounded-md border border-line bg-surface p-4 shadow-sm">
                <AccountControls email={email} onDisconnect={onDisconnect} />
              </div>
            </details>
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
                    className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors ${
                      active ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-surface-2"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
            <span className="mx-1 hidden h-5 w-px bg-line sm:inline-block" aria-hidden="true" />
            <RefreshControl
              onRefresh={onRefresh}
              refreshing={refreshing}
              online={online}
              lastSyncedAt={lastSyncedAt}
              syncSummary={syncSummary}
            />
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      {error !== null && <ErrorLine error={error} />}
      <Footer />
    </div>
  );
}

// ---- Desktop shell: left sidebar + wide content ---------------------------------------

function DesktopShell({
  email,
  online,
  view,
  onNavigate,
  onRefresh,
  refreshing,
  lastSyncedAt,
  syncSummary,
  onDisconnect,
  error,
  demo,
  onExitDemo,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      {demo === true && <DemoBanner onExit={onExitDemo} />}
      {!online && <OfflineBanner />}

      <div className="mx-auto flex w-full max-w-7xl flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
          <div className="px-5 py-5">
            <Brand onNavigate={onNavigate} />
          </div>
          <nav className="flex flex-col gap-1 px-3" aria-label="Primary">
            {NAV.map((item) => {
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-11 items-center rounded-md px-3 text-left text-sm font-medium transition-colors ${
                    active ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-surface-2"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="mt-auto space-y-3 border-t border-line px-5 py-4">
            <AccountControls email={email} onDisconnect={onDisconnect} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-end gap-1 border-b border-line bg-surface px-6 py-3">
            <RefreshControl
              onRefresh={onRefresh}
              refreshing={refreshing}
              online={online}
              lastSyncedAt={lastSyncedAt}
              syncSummary={syncSummary}
            />
          </div>
          <main className="flex-1">{children}</main>
          {error !== null && <ErrorLine error={error} />}
        </div>
      </div>

      <Footer />
    </div>
  );
}
