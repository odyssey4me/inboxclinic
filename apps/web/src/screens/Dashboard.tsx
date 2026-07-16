// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  computeTrustScore,
  enforce,
  senderToSnapshot,
  type GmailClient,
  type Sender,
  type Store,
  type TrustStatus,
} from "@inboxclinic/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { PriorDecisionsImport } from "../components/composed/PriorDecisionsImport";
import { ScoreIndicator } from "../components/composed/ScoreIndicator";
import { SenderDetail } from "../components/composed/SenderDetail";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { useStoreSnapshot } from "../hooks/useStoreSnapshot";
import { useLayout } from "../layout/context";
import { relativeTime } from "../lib/relativeTime";
import { statusTone } from "../lib/statusTone";

export interface DashboardProps {
  store: Store;
  gmail: GmailClient;
  online: boolean;
  /** Bumped by the app after a sync/restore so the surface re-reads without remounting. */
  refreshKey: number;
  /** Launch the guided 3-phase triage wizard (the optional fast-path). */
  onStartWorkflow: () => void;
  /** Called after a decision is applied so the app can refresh other views. */
  onChanged: () => void;
}

/** Which decisions the surface shows. Counts live in the tab labels (design-frontend.md D8). */
type Tab = "pending" | "decided" | "all";
/** Sort dimensions that matter for triage (design-frontend.md Decision 8). */
type SortKey = "name" | "score" | "unread" | "volume" | "recency" | "status";
type SortDir = "asc" | "desc";

/** Rows rendered before the list is capped; search + sort keep the highest-value ones on top. */
const SENDERS_CAP = 50;

const STATUS_ORDER: Record<TrustStatus, number> = { pending: 0, trusted: 1, blocked: 2 };

const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  score: "Trust score",
  unread: "Most unread",
  volume: "Most emails",
  recency: "Recently active",
  status: "Decision status",
};

/** Default direction when a sort key is first chosen (text ascends, metrics descend). */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  score: "desc",
  unread: "desc",
  volume: "desc",
  recency: "desc",
  status: "asc",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ignored rate: `1 − readRate` as a fraction; `null` when the sender has no read data. */
function unreadRate(sender: Sender): number | null {
  return sender.readRate === null ? null : 1 - sender.readRate;
}

/**
 * Home — the decisions surface (design-frontend.md Decision 8). One searchable,
 * richly-sortable table of senders with Pending·Decided·All tabs, a status column, inline
 * Trust/Block/Defer, and a row → detail side-panel where a decision's impact is previewed
 * and per-address exceptions/history live. The guided 3-phase wizard is an optional
 * "Triage pending" fast-path launched from here.
 */
export function Dashboard({
  store,
  gmail,
  online,
  refreshKey,
  onStartWorkflow,
  onChanged,
}: DashboardProps) {
  const { data, error, reload } = useStoreSnapshot(store);
  const { layout } = useLayout();
  const desktop = layout === "desktop";

  const [tab, setTab] = useState<Tab>("pending");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("volume");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<Sender | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Re-read the snapshot when the app signals a data change (sync/restore, or a decision
  // applied from a detail panel) — without remounting, so the tab/search/sort survive a
  // rapid triage run. The hook already does the first read on mount.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    reload();
  }, [refreshKey, reload]);

  const senders = useMemo(() => data?.senders ?? [], [data]);
  const openPrompts = (data?.prompts ?? []).filter((p) => p.resolvedAt === null);

  // Trust scores are pure arithmetic but we still avoid recomputing them per comparison.
  const scoreById = useMemo(
    () => new Map(senders.map((s) => [s.id, computeTrustScore(senderToSnapshot(s)).score])),
    [senders],
  );

  const q = query.trim().toLowerCase();
  const searchFiltered = senders.filter(
    (s) =>
      q === "" ||
      s.email.toLowerCase().includes(q) ||
      s.domain.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      s.trustStatus.toLowerCase().includes(q),
  );

  const counts = {
    pending: searchFiltered.filter((s) => s.trustStatus === "pending").length,
    decided: searchFiltered.filter((s) => s.trustStatus !== "pending").length,
    all: searchFiltered.length,
  };

  const inTab = searchFiltered.filter((s) =>
    tab === "all"
      ? true
      : tab === "pending"
        ? s.trustStatus === "pending"
        : s.trustStatus !== "pending",
  );

  const compare = (a: Sender, b: Sender): number => {
    switch (sortKey) {
      case "name":
        return a.email.localeCompare(b.email);
      case "score":
        return (scoreById.get(a.id) ?? 0) - (scoreById.get(b.id) ?? 0);
      case "unread": {
        // No read data sorts last regardless of direction, so unknowns never top the list.
        const ua = unreadRate(a);
        const ub = unreadRate(b);
        if (ua === null) return ub === null ? 0 : 1;
        if (ub === null) return -1;
        return sortDir === "asc" ? ua - ub : -(ua - ub);
      }
      case "volume":
        return a.totalEmails - b.totalEmails;
      case "recency":
        return a.lastSeenAt - b.lastSeenAt;
      case "status":
        return STATUS_ORDER[a.trustStatus] - STATUS_ORDER[b.trustStatus];
    }
  };

  const sorted = [...inTab].sort((a, b) => {
    // "unread" already applied direction internally (to keep nulls last both ways).
    const raw = compare(a, b);
    const primary = sortKey === "unread" ? raw : sortDir === "asc" ? raw : -raw;
    return primary !== 0 ? primary : b.totalEmails - a.totalEmails;
  });
  const shown = sorted.slice(0, SENDERS_CAP);

  const onSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  // Trust/Defer are safe and apply immediately. Block can archive/delete mail, so it opens
  // the detail panel where the impact is previewed and confirmed (design-trust-decisions.md).
  const quickDecide = async (sender: Sender, decision: "trust" | "defer"): Promise<void> => {
    setBusyId(sender.id);
    setActionError(null);
    try {
      await applyDecision(store, {
        subjectId: sender.id,
        scope: "address",
        decision,
        actions: [],
        decidedVia: "dashboard",
        now: Date.now(),
      });
      await enforce(gmail, store);
      reload();
      onChanged();
    } catch (caught) {
      setActionError(`Could not apply: ${errorMessage(caught)}`);
    } finally {
      setBusyId(null);
    }
  };

  const renderActions = (sender: Sender) => {
    const disabled = !online || busyId === sender.id;
    return (
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={`Decide ${sender.email}`}
        onClick={(event) => event.stopPropagation()}
      >
        {sender.trustStatus !== "trusted" && (
          <Button
            variant="trust"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => void quickDecide(sender, "trust")}
          >
            Trust
          </Button>
        )}
        {sender.trustStatus !== "blocked" && (
          <Button
            variant="danger"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => setSelected(sender)}
          >
            Block
          </Button>
        )}
        {sender.trustStatus === "pending" && (
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => void quickDecide(sender, "defer")}
          >
            Defer
          </Button>
        )}
      </div>
    );
  };

  const emptyMessage =
    senders.length === 0
      ? "No senders yet — run a scan from Settings to start triaging."
      : `No ${tab === "all" ? "" : tab + " "}senders${q === "" ? "" : ` match “${query}”`}.`;

  const table = (
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-line text-muted">
          <SortHeader
            label="Sender"
            sortKey="name"
            active={sortKey}
            dir={sortDir}
            onSort={onSort}
          />
          <SortHeader
            label="Score"
            sortKey="score"
            active={sortKey}
            dir={sortDir}
            onSort={onSort}
          />
          <SortHeader
            label="Unread"
            sortKey="unread"
            active={sortKey}
            dir={sortDir}
            onSort={onSort}
          />
          <SortHeader
            label="Last seen"
            sortKey="recency"
            active={sortKey}
            dir={sortDir}
            onSort={onSort}
          />
          <SortHeader
            label="Status"
            sortKey="status"
            active={sortKey}
            dir={sortDir}
            onSort={onSort}
          />
          <SortHeader
            label="Emails"
            sortKey="volume"
            active={sortKey}
            dir={sortDir}
            onSort={onSort}
            align="right"
          />
          <th className="py-2 pl-4 text-right font-medium">Actions</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((sender) => {
          const unread = unreadRate(sender);
          return (
            <tr
              key={sender.id}
              tabIndex={0}
              onClick={() => setSelected(sender)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setSelected(sender);
              }}
              className="cursor-pointer border-b border-line transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
            >
              <td className="py-2 pr-4">
                <p className="font-medium text-ink">{sender.email}</p>
                <p className="text-xs text-muted">{sender.category}</p>
              </td>
              <td className="py-2 pr-4">
                <ScoreIndicator score={scoreById.get(sender.id) ?? 0} />
              </td>
              <td className="py-2 pr-4 tabular-nums text-muted">
                {unread === null ? "—" : `${Math.round(unread * 100)}%`}
              </td>
              <td className="py-2 pr-4 text-muted">{relativeTime(sender.lastSeenAt)}</td>
              <td className="py-2 pr-4">
                <Badge tone={statusTone(sender.trustStatus)}>{sender.trustStatus}</Badge>
              </td>
              <td className="py-2 pl-4 text-right tabular-nums">{sender.totalEmails}</td>
              <td className="py-2 pl-4">
                <div className="flex justify-end">{renderActions(sender)}</div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const cards = (
    <ul className="space-y-2">
      {shown.map((sender) => {
        const unread = unreadRate(sender);
        return (
          <li
            key={sender.id}
            tabIndex={0}
            onClick={() => setSelected(sender)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setSelected(sender);
            }}
            className="cursor-pointer space-y-2 rounded-md border border-line px-3 py-2 transition-colors hover:border-accent/40 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{sender.email}</p>
                <p className="truncate text-xs text-muted">
                  {sender.category} · {sender.totalEmails} emails
                  {unread === null ? "" : ` · ${Math.round(unread * 100)}% unread`}
                </p>
              </div>
              <Badge tone={statusTone(sender.trustStatus)}>{sender.trustStatus}</Badge>
            </div>
            <div className="flex items-center justify-between gap-2">
              <ScoreIndicator score={scoreById.get(sender.id) ?? 0} />
              {renderActions(sender)}
            </div>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className={`mx-auto flex flex-col gap-6 px-4 py-8 ${desktop ? "max-w-6xl" : "max-w-3xl"}`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold tracking-tight">Decisions</h2>
          <p className="text-sm text-muted">
            Every sender in one place — search, sort, and Trust, Block or Defer each one.
          </p>
        </div>
        {openPrompts.length > 0 && (
          <Button onClick={onStartWorkflow}>Triage {openPrompts.length} pending →</Button>
        )}
      </div>

      {error !== null && (
        <div role="alert" className="flex items-center justify-between gap-3 text-sm text-block">
          <span>Couldn't load your data: {error}</span>
          <Button variant="ghost" onClick={reload}>
            Retry
          </Button>
        </div>
      )}
      {actionError !== null && (
        <p role="alert" className="text-sm text-block">
          {actionError}
        </p>
      )}

      <PriorDecisionsImport store={store} gmail={gmail} online={online} onImported={onChanged} />

      <section aria-label="Decisions" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="tablist"
            aria-label="Filter by decision"
            className="flex gap-1 rounded-md bg-surface-2 p-1"
          >
            {(["pending", "decided", "all"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`min-h-8 rounded px-3 text-sm font-medium capitalize transition-colors ${
                  tab === id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {id} ({counts[id]})
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {!desktop && senders.length > 0 && (
              <div className="flex items-center gap-1">
                <label className="sr-only" htmlFor="sort-key">
                  Sort by
                </label>
                <select
                  id="sort-key"
                  value={sortKey}
                  onChange={(event) => onSort(event.target.value as SortKey)}
                  className="min-h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                    <option key={key} value={key}>
                      {SORT_LABELS[key]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                  aria-label={`Sort ${sortDir === "asc" ? "ascending" : "descending"}`}
                  className="min-h-9 rounded-md border border-line px-2 text-sm text-muted hover:text-ink"
                >
                  {sortDir === "asc" ? "▲" : "▼"}
                </button>
              </div>
            )}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search senders…"
              aria-label="Search senders"
              className="min-h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-56"
            />
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="text-sm text-muted">{emptyMessage}</p>
        ) : (
          <>
            {desktop ? table : cards}
            {inTab.length > shown.length && (
              <p className="text-xs text-muted">
                Showing {shown.length} of {inTab.length}. Search to narrow.
              </p>
            )}
          </>
        )}
      </section>

      <SenderDetail
        sender={selected}
        store={store}
        gmail={gmail}
        online={online}
        onClose={() => setSelected(null)}
        onChanged={onChanged}
      />
    </div>
  );
}

/** A clickable, sortable column header that reflects and toggles the active sort. */
function SortHeader({
  label,
  sortKey: key,
  active,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = active === key;
  return (
    <th
      aria-sort={isActive ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`py-2 font-medium ${align === "right" ? "pl-4 text-right" : "pr-4 text-left"}`}
    >
      <button
        type="button"
        onClick={() => onSort(key)}
        className={`inline-flex items-center gap-1 font-medium transition-colors hover:text-ink ${
          isActive ? "text-ink" : "text-muted"
        }`}
      >
        {label}
        <span aria-hidden="true" className="text-[10px]">
          {isActive ? (dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}
