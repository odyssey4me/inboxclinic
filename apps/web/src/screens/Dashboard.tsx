// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  computeTrustScore,
  enforce,
  resolveEffectiveDecision,
  senderToSnapshot,
  type Domain,
  type GmailClient,
  type Sender,
  type Store,
  type TrustStatus,
} from "@inboxclinic/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { DomainDetail } from "../components/composed/DomainDetail";
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
const ROW_CAP = 50;

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

/** Sort keys that make sense for domain aggregates (no per-message unread/recency). */
const DOMAIN_SORT_KEYS: SortKey[] = ["name", "score", "volume", "status"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ignored rate: `1 − readRate` as a fraction; `null` when the sender has no read data. */
function unreadRate(sender: Sender): number | null {
  return sender.readRate === null ? null : 1 - sender.readRate;
}

/** Average member trust score — the domain-level stand-in (design-frontend.md Decision 8). */
function averageDomainScore(members: Sender[]): number | null {
  if (members.length === 0) return null;
  const sum = members.reduce((acc, m) => acc + computeTrustScore(senderToSnapshot(m)).score, 0);
  return sum / members.length;
}

/**
 * Home — the decisions surface (design-frontend.md Decision 8). One searchable,
 * richly-sortable table with Pending·Decided·All tabs, a status column, inline
 * Trust/Block/Defer, and a row → detail side-panel where impact is previewed and per-address
 * exceptions/history live. A **Group by domain** toggle switches senders for their domains so
 * a domain and its members are decided together. The guided 3-phase wizard is an optional
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
  const [groupByDomain, setGroupByDomain] = useState(false);
  const [selected, setSelected] = useState<Sender | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);
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
  const domains = useMemo(() => data?.domains ?? [], [data]);
  const openPrompts = (data?.prompts ?? []).filter((p) => p.resolvedAt === null);

  // Trust scores are pure arithmetic but we still avoid recomputing them per comparison.
  const scoreById = useMemo(
    () => new Map(senders.map((s) => [s.id, computeTrustScore(senderToSnapshot(s)).score])),
    [senders],
  );
  const membersByDomain = useMemo(() => {
    const map = new Map<string, Sender[]>();
    for (const s of senders) {
      const arr = map.get(s.domain);
      if (arr) arr.push(s);
      else map.set(s.domain, [s]);
    }
    return map;
  }, [senders]);
  const membersOf = (domain: Domain): Sender[] => membersByDomain.get(domain.domain) ?? [];
  const domainScoreById = useMemo(
    () =>
      new Map(domains.map((d) => [d.id, averageDomainScore(membersByDomain.get(d.domain) ?? [])])),
    [domains, membersByDomain],
  );
  const domainByName = useMemo(() => new Map(domains.map((d) => [d.domain, d])), [domains]);

  // A domain-scope decision covers its members (design-trust-decisions.md Decision 2) without
  // rewriting their sender records, so resolve each sender's *effective* status for the sender
  // surface — otherwise a domain-trusted sender would still read "pending" here.
  const effectiveStatusById = useMemo(() => {
    const map = new Map<string, TrustStatus>();
    for (const s of senders) {
      const d = domainByName.get(s.domain);
      map.set(
        s.id,
        resolveEffectiveDecision({
          addressStatus: s.trustStatus === "pending" ? null : s.trustStatus,
          addressIsException: d?.exceptionAddresses.includes(s.email) ?? false,
          domainStatus: d && d.trustStatus !== "pending" ? d.trustStatus : null,
          domainScope: d?.decisionScope ?? null,
        }).status,
      );
    }
    return map;
  }, [senders, domainByName]);
  const effectiveStatus = (sender: Sender): TrustStatus =>
    effectiveStatusById.get(sender.id) ?? sender.trustStatus;

  const q = query.trim().toLowerCase();
  const onSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const toggleGroupByDomain = (): void => {
    const next = !groupByDomain;
    setGroupByDomain(next);
    // The unread/recency sorts have no domain equivalent — fall back to volume when grouping.
    if (next && !DOMAIN_SORT_KEYS.includes(sortKey)) {
      setSortKey("volume");
      setSortDir("desc");
    }
  };

  // ---- Sender surface ---------------------------------------------------------------
  const searchFiltered = senders.filter(
    (s) =>
      q === "" ||
      s.email.toLowerCase().includes(q) ||
      s.domain.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      effectiveStatus(s).toLowerCase().includes(q),
  );
  const senderCounts = {
    pending: searchFiltered.filter((s) => effectiveStatus(s) === "pending").length,
    decided: searchFiltered.filter((s) => effectiveStatus(s) !== "pending").length,
    all: searchFiltered.length,
  };
  const inTab = searchFiltered.filter((s) =>
    tab === "all"
      ? true
      : tab === "pending"
        ? effectiveStatus(s) === "pending"
        : effectiveStatus(s) !== "pending",
  );
  const compareSender = (a: Sender, b: Sender): number => {
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
        return STATUS_ORDER[effectiveStatus(a)] - STATUS_ORDER[effectiveStatus(b)];
    }
  };
  const sortedSenders = [...inTab].sort((a, b) => {
    // "unread" already applied direction internally (to keep nulls last both ways).
    const raw = compareSender(a, b);
    const primary = sortKey === "unread" ? raw : sortDir === "asc" ? raw : -raw;
    return primary !== 0 ? primary : b.totalEmails - a.totalEmails;
  });
  const shownSenders = sortedSenders.slice(0, ROW_CAP);

  // ---- Domain surface ---------------------------------------------------------------
  const domainSearchFiltered = domains.filter(
    (d) =>
      q === "" || d.domain.toLowerCase().includes(q) || d.trustStatus.toLowerCase().includes(q),
  );
  const domainCounts = {
    pending: domainSearchFiltered.filter((d) => d.trustStatus === "pending").length,
    decided: domainSearchFiltered.filter((d) => d.trustStatus !== "pending").length,
    all: domainSearchFiltered.length,
  };
  const domainsInTab = domainSearchFiltered.filter((d) =>
    tab === "all"
      ? true
      : tab === "pending"
        ? d.trustStatus === "pending"
        : d.trustStatus !== "pending",
  );
  const compareDomain = (a: Domain, b: Domain): number => {
    switch (sortKey) {
      case "name":
        return a.domain.localeCompare(b.domain);
      case "score": {
        // A domain with no scoreable members sorts last regardless of direction (mirrors the
        // sender "unread" null-handling), so it's applied here and skipped in the wrapper.
        const sa = domainScoreById.get(a.id) ?? null;
        const sb = domainScoreById.get(b.id) ?? null;
        if (sa === null) return sb === null ? 0 : 1;
        if (sb === null) return -1;
        return sortDir === "asc" ? sa - sb : -(sa - sb);
      }
      case "status":
        return STATUS_ORDER[a.trustStatus] - STATUS_ORDER[b.trustStatus];
      default: // volume (and any non-domain key coerced on toggle)
        return a.totalEmails - b.totalEmails;
    }
  };
  const sortedDomains = [...domainsInTab].sort((a, b) => {
    const raw = compareDomain(a, b);
    const primary = sortKey === "score" ? raw : sortDir === "asc" ? raw : -raw;
    return primary !== 0 ? primary : b.totalEmails - a.totalEmails;
  });
  const shownDomains = sortedDomains.slice(0, ROW_CAP);

  // ---- Active view (senders vs domains) ---------------------------------------------
  const counts = groupByDomain ? domainCounts : senderCounts;
  const inTabLen = groupByDomain ? domainsInTab.length : inTab.length;
  const shownLen = groupByDomain ? shownDomains.length : shownSenders.length;
  const noData = groupByDomain ? domains.length === 0 : senders.length === 0;
  const emptyMessage = noData
    ? "No senders yet — run a scan from Settings to start triaging."
    : `No ${tab === "all" ? "" : tab + " "}${groupByDomain ? "domains" : "senders"}${
        q === "" ? "" : ` match “${query}”`
      }.`;
  const sortOptions = groupByDomain
    ? (Object.keys(SORT_LABELS) as SortKey[]).filter((k) => DOMAIN_SORT_KEYS.includes(k))
    : (Object.keys(SORT_LABELS) as SortKey[]);

  // ---- Inline decisions -------------------------------------------------------------
  // Trust/Defer are safe and apply immediately. Block can archive/delete mail, so it opens
  // the detail panel where the impact is previewed and confirmed (design-trust-decisions.md).
  const quickDecide = async (
    subjectId: string,
    scope: "address" | "domain",
    decision: "trust" | "defer",
  ): Promise<void> => {
    setBusyId(subjectId);
    setActionError(null);
    try {
      await applyDecision(store, {
        subjectId,
        scope,
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

  const renderSenderActions = (sender: Sender) => {
    const disabled = !online || busyId === sender.id;
    const status = effectiveStatus(sender);
    return (
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={`Decide ${sender.email}`}
        onClick={(event) => event.stopPropagation()}
      >
        {status !== "trusted" && (
          <Button
            variant="trust"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => void quickDecide(sender.id, "address", "trust")}
          >
            Trust
          </Button>
        )}
        {status !== "blocked" && (
          <Button
            variant="danger"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => setSelected(sender)}
          >
            Block
          </Button>
        )}
        {status === "pending" && (
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => void quickDecide(sender.id, "address", "defer")}
          >
            Defer
          </Button>
        )}
      </div>
    );
  };

  const renderDomainActions = (domain: Domain) => {
    const disabled = !online || busyId === domain.id;
    return (
      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={`Decide ${domain.domain}`}
        onClick={(event) => event.stopPropagation()}
      >
        {domain.trustStatus !== "trusted" && (
          <Button
            variant="trust"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => void quickDecide(domain.id, "domain", "trust")}
          >
            Trust
          </Button>
        )}
        {domain.trustStatus !== "blocked" && (
          <Button
            variant="danger"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => setSelectedDomain(domain)}
          >
            Block
          </Button>
        )}
        {domain.trustStatus === "pending" && (
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => void quickDecide(domain.id, "domain", "defer")}
          >
            Defer
          </Button>
        )}
      </div>
    );
  };

  // ---- Renderers --------------------------------------------------------------------
  const senderTable = (
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
        {shownSenders.map((sender) => {
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
                <Badge tone={statusTone(effectiveStatus(sender))}>{effectiveStatus(sender)}</Badge>
              </td>
              <td className="py-2 pl-4 text-right tabular-nums">{sender.totalEmails}</td>
              <td className="py-2 pl-4">
                <div className="flex justify-end">{renderSenderActions(sender)}</div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const senderCards = (
    <ul className="space-y-2">
      {shownSenders.map((sender) => {
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
              <Badge tone={statusTone(effectiveStatus(sender))}>{effectiveStatus(sender)}</Badge>
            </div>
            <div className="flex items-center justify-between gap-2">
              <ScoreIndicator score={scoreById.get(sender.id) ?? 0} />
              {renderSenderActions(sender)}
            </div>
          </li>
        );
      })}
    </ul>
  );

  const domainTable = (
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-line text-muted">
          <SortHeader
            label="Domain"
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
          <th className="py-2 pr-4 text-left font-medium">Senders</th>
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
        {shownDomains.map((domain) => {
          const score = domainScoreById.get(domain.id) ?? null;
          return (
            <tr
              key={domain.id}
              tabIndex={0}
              onClick={() => setSelectedDomain(domain)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setSelectedDomain(domain);
              }}
              className="cursor-pointer border-b border-line transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
            >
              <td className="py-2 pr-4 font-medium text-ink">{domain.domain}</td>
              <td className="py-2 pr-4">
                {score === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <ScoreIndicator score={score} />
                )}
              </td>
              <td className="py-2 pr-4 tabular-nums text-muted">{domain.senderCount}</td>
              <td className="py-2 pr-4">
                <Badge tone={statusTone(domain.trustStatus)}>{domain.trustStatus}</Badge>
              </td>
              <td className="py-2 pl-4 text-right tabular-nums">{domain.totalEmails}</td>
              <td className="py-2 pl-4">
                <div className="flex justify-end">{renderDomainActions(domain)}</div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const domainCards = (
    <ul className="space-y-2">
      {shownDomains.map((domain) => {
        const score = domainScoreById.get(domain.id) ?? null;
        return (
          <li
            key={domain.id}
            tabIndex={0}
            onClick={() => setSelectedDomain(domain)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setSelectedDomain(domain);
            }}
            className="cursor-pointer space-y-2 rounded-md border border-line px-3 py-2 transition-colors hover:border-accent/40 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{domain.domain}</p>
                <p className="truncate text-xs text-muted">
                  {domain.senderCount} sender{domain.senderCount === 1 ? "" : "s"} ·{" "}
                  {domain.totalEmails} emails
                </p>
              </div>
              <Badge tone={statusTone(domain.trustStatus)}>{domain.trustStatus}</Badge>
            </div>
            <div className="flex items-center justify-between gap-2">
              {score === null ? (
                <span className="text-xs text-muted">no score</span>
              ) : (
                <ScoreIndicator score={score} />
              )}
              {renderDomainActions(domain)}
            </div>
          </li>
        );
      })}
    </ul>
  );

  const list = groupByDomain
    ? desktop
      ? domainTable
      : domainCards
    : desktop
      ? senderTable
      : senderCards;

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

          <div className="flex flex-wrap items-center gap-2">
            {senders.length > 0 && (
              <label className="flex items-center gap-1.5 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={groupByDomain}
                  onChange={toggleGroupByDomain}
                  className="accent-accent"
                />
                Group by domain
              </label>
            )}
            {!desktop && !noData && (
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
                  {sortOptions.map((key) => (
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
              placeholder={groupByDomain ? "Search domains…" : "Search senders…"}
              aria-label={groupByDomain ? "Search domains" : "Search senders"}
              className="min-h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-56"
            />
          </div>
        </div>

        {shownLen === 0 ? (
          <p className="text-sm text-muted">{emptyMessage}</p>
        ) : (
          <>
            {list}
            {inTabLen > shownLen && (
              <p className="text-xs text-muted">
                Showing {shownLen} of {inTabLen}. Search to narrow.
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

      <DomainDetail
        domain={selectedDomain}
        members={selectedDomain !== null ? membersOf(selectedDomain) : []}
        store={store}
        gmail={gmail}
        online={online}
        onClose={() => setSelectedDomain(null)}
        onOpenSender={(sender) => {
          setSelectedDomain(null);
          setSelected(sender);
        }}
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
