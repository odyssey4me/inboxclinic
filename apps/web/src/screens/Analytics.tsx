// SPDX-License-Identifier: Apache-2.0
import {
  analyticsSummary,
  buildSnapshot,
  snapshotText,
  timeSavedMinutes,
  type AnalyticsSummary,
  type CategoryStat,
  type DomainVolume,
  type Store,
  type TrendPoint,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ProgressBar } from "../components/ui/ProgressBar";

export interface AnalyticsProps {
  store: Store;
}

function healthTone(score: number): { tone: "green" | "amber" | "red"; label: string } {
  if (score >= 80) return { tone: "green", label: "Healthy" };
  if (score >= 50) return { tone: "amber", label: "Fair" };
  return { tone: "red", label: "Needs attention" };
}

/** Trigger a local download of `text` as a named file (no network). */
function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Analytics dashboard: inbox health, a 30-day summary, breakdowns, and achievements. */
export function Analytics({ store }: AnalyticsProps) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await analyticsSummary(store, { now: Date.now() });
      if (active) setSummary(result);
    })();
    return () => {
      active = false;
    };
  }, [store]);

  if (summary === null) {
    return <p className="p-6 text-center text-slate-500">Loading analytics…</p>;
  }

  const onDownloadSnapshot = (): void => {
    const snapshot = buildSnapshot(summary);
    downloadText(
      "inbox-clinic-snapshot.json",
      JSON.stringify(snapshot, null, 2),
      "application/json",
    );
    setShareNote("Snapshot downloaded — it contains only aggregate numbers, never addresses.");
  };

  const onCopySummary = async (): Promise<void> => {
    const text = snapshotText(buildSnapshot(summary));
    try {
      await navigator.clipboard.writeText(text);
      setShareNote("Summary copied to the clipboard.");
    } catch {
      setShareNote(text);
    }
  };

  const health = healthTone(summary.inboxHealthScore);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <h2 className="text-2xl font-bold tracking-tight">Analytics</h2>

      <Card aria-label="Inbox health score" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Inbox health</h2>
          <Badge tone={health.tone}>{health.label}</Badge>
        </div>
        <p className="text-4xl font-bold tabular-nums text-slate-900">
          {summary.inboxHealthScore}
          <span className="text-lg font-normal text-slate-400"> / 100</span>
        </p>
        <ProgressBar value={summary.inboxHealthScore} max={100} label="Inbox health score" />
      </Card>

      <section aria-label="30-day summary" className="space-y-2">
        <h2 className="text-lg font-semibold">Last {summary.windowDays} days</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Decisions" value={summary.window.decisionsMade} />
          <Stat label="Senders blocked" value={summary.window.sendersBlocked} />
          <Stat label="Senders trusted" value={summary.window.sendersTrusted} />
          <Stat label="New senders" value={summary.window.newSenders} />
          <Stat label="Emails blocked" value={summary.window.emailsBlocked} />
          <Stat label="Time saved (min)" value={timeSavedMinutes(summary.estimatedTimeSaved)} />
        </div>
      </section>

      {summary.trend.length > 0 && <TrendChart trend={summary.trend} />}

      {summary.categories.length > 0 && <CategoryBreakdown categories={summary.categories} />}

      <DomainLists volume={summary.topDomains} blocked={summary.topBlockedDomains} />

      <Achievements achievements={summary.achievements} />

      <section aria-label="Share" className="space-y-3">
        <h2 className="text-lg font-semibold">Share your progress</h2>
        <p className="text-sm text-slate-500">
          Snapshots are created on your device and shared only if you choose to. They contain
          aggregate numbers only — never senders, addresses, or message content. No server, no
          tracking.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onDownloadSnapshot}>
            Export snapshot (JSON)
          </Button>
          <Button variant="secondary" onClick={() => void onCopySummary()}>
            Copy text summary
          </Button>
        </div>
        {shareNote !== null && (
          <p role="status" className="whitespace-pre-line text-sm text-emerald-700">
            {shareNote}
          </p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="text-center">
      <p className="text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </Card>
  );
}

function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const max = Math.max(1, ...trend.map((p) => p.emailsBlocked));
  return (
    <section aria-label="Emails blocked trend" className="space-y-2">
      <h2 className="text-lg font-semibold">Emails blocked per day</h2>
      <div className="flex h-24 items-end gap-1" role="img" aria-label="Emails blocked per day">
        {trend.map((point) => (
          <div
            key={point.date}
            title={`${point.date}: ${point.emailsBlocked} blocked`}
            className="flex-1 rounded-t bg-emerald-500"
            style={{ height: `${Math.round((point.emailsBlocked / max) * 100)}%` }}
          />
        ))}
      </div>
    </section>
  );
}

function CategoryBreakdown({ categories }: { categories: CategoryStat[] }) {
  const max = Math.max(1, ...categories.map((c) => c.emails));
  return (
    <section aria-label="Category breakdown" className="space-y-2">
      <h2 className="text-lg font-semibold">Email by category</h2>
      <ul className="space-y-2">
        {categories.map((category) => (
          <li key={category.category} className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="capitalize text-slate-700">{category.category}</span>
              <span className="tabular-nums text-slate-500">
                {category.emails} emails · {category.senders} senders
              </span>
            </div>
            <ProgressBar value={category.emails} max={max} label={`${category.category} volume`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DomainList({ title, domains }: { title: string; domains: DomainVolume[] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      {domains.length === 0 ? (
        <p className="text-sm text-slate-400">None yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {domains.map((domain) => (
            <li key={domain.domain} className="flex justify-between">
              <span className="truncate text-slate-700">{domain.domain}</span>
              <span className="tabular-nums text-slate-500">{domain.totalEmails}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DomainLists({ volume, blocked }: { volume: DomainVolume[]; blocked: DomainVolume[] }) {
  return (
    <section aria-label="Top domains" className="grid gap-4 sm:grid-cols-2">
      <Card>
        <DomainList title="Top domains by volume" domains={volume} />
      </Card>
      <Card>
        <DomainList title="Top blocked domains" domains={blocked} />
      </Card>
    </section>
  );
}

function Achievements({ achievements }: { achievements: AnalyticsSummary["achievements"] }) {
  return (
    <section aria-label="Achievements" className="space-y-2">
      <h2 className="text-lg font-semibold">Achievements</h2>
      <ul className="flex flex-wrap gap-2">
        {achievements.map((achievement) => (
          <li key={achievement.id}>
            <Badge
              tone={achievement.earned ? "green" : "neutral"}
              title={achievement.description}
              className={achievement.earned ? "" : "opacity-50"}
            >
              {achievement.earned ? "★ " : "☆ "}
              {achievement.name}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
