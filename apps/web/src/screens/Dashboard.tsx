// SPDX-License-Identifier: Apache-2.0
import {
  computeTrustScore,
  healthInputFromSenders,
  inboxHealthScore,
  senderToSnapshot,
  type GmailClient,
  type Sender,
  type Store,
} from "@inboxclinic/core";
import { useState } from "react";

import { ScoreIndicator } from "../components/composed/ScoreIndicator";
import { SenderDetail } from "../components/composed/SenderDetail";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ProgressBar } from "../components/ui/ProgressBar";
import { useStoreSnapshot } from "../hooks/useStoreSnapshot";
import { useLayout } from "../layout/context";
import { healthTone } from "../lib/health";

export interface DashboardProps {
  store: Store;
  gmail: GmailClient;
  online: boolean;
  onStartWorkflow: () => void;
  /** Called after a sender decision is applied from the detail drawer. */
  onChanged: () => void;
}

function Stat({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick?: (() => void) | undefined;
}) {
  const body = (
    <>
      <p className="text-2xl font-bold tabular-nums text-ink">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </>
  );
  if (onClick !== undefined) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-lg border border-line bg-surface p-4 text-center shadow-sm transition-colors hover:border-accent/40 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {body}
      </button>
    );
  }
  return <Card className="text-center">{body}</Card>;
}

/** Trust status as a colour-coded chip (colour is always paired with the status word). */
function statusTone(status: Sender["trustStatus"]): BadgeTone {
  if (status === "trusted") return "green";
  if (status === "blocked") return "red";
  return "neutral";
}

/** Dashboard: inbox-health hero + next action, counts, top pending prompts, sender list. */
/** Rows rendered before the list is capped (search narrows the rest). */
const SENDERS_CAP = 50;

export function Dashboard({ store, gmail, online, onStartWorkflow, onChanged }: DashboardProps) {
  const { data } = useStoreSnapshot(store);
  const { layout } = useLayout();
  const desktop = layout === "desktop";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Sender | null>(null);

  const senders = data?.senders ?? [];
  const domains = data?.domains ?? [];
  const openPrompts = (data?.prompts ?? []).filter((p) => p.resolvedAt === null);
  const senderById = new Map(senders.map((s) => [s.id, s]));

  // Search across address/domain/category/status, then order by volume so the cap keeps
  // the highest-impact senders.
  const q = query.trim().toLowerCase();
  const filteredSenders = [...senders]
    .filter(
      (s) =>
        q === "" ||
        s.email.toLowerCase().includes(q) ||
        s.domain.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.trustStatus.toLowerCase().includes(q),
    )
    .sort((a, b) => b.totalEmails - a.totalEmails);
  const shownSenders = filteredSenders.slice(0, SENDERS_CAP);

  const topPending = [...openPrompts]
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .map((p) => senderById.get(p.senderId))
    .filter((s): s is Sender => s !== undefined)
    .slice(0, desktop ? 6 : 3);

  const health = senders.length > 0 ? inboxHealthScore(healthInputFromSenders(senders)) : null;
  const tone = health !== null ? healthTone(health) : null;

  const heroCard = (
    <Card aria-label="Inbox health" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Inbox health</h2>
          {tone !== null && <Badge tone={tone.badge}>{tone.label}</Badge>}
        </div>
        {openPrompts.length > 0 ? (
          <Button onClick={onStartWorkflow}>Review {openPrompts.length}</Button>
        ) : (
          senders.length > 0 && <span className="text-sm text-muted">All caught up</span>
        )}
      </div>
      {health !== null && tone !== null ? (
        <>
          <p className="text-4xl font-bold tabular-nums text-ink">
            {health}
            <span className="text-lg font-normal text-muted"> / 100</span>
          </p>
          <ProgressBar value={health} max={100} tone={tone.bar} label="Inbox health score" />
        </>
      ) : (
        <p className="text-sm text-muted">
          Scan your inbox to see its health and start triaging senders.
        </p>
      )}
    </Card>
  );

  const pendingSection =
    openPrompts.length > 0 ? (
      <section className="space-y-3" aria-label="Pending decisions">
        <h2 className="text-lg font-semibold">Pending decisions</h2>
        <ul className="space-y-2">
          {topPending.map((sender) => (
            <li key={sender.id}>
              <button
                type="button"
                onClick={() => setSelected(sender)}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-left text-sm transition-colors hover:border-accent/40 hover:bg-surface-2"
              >
                <span className="truncate font-medium text-ink">{sender.email}</span>
                <ScoreIndicator score={computeTrustScore(senderToSnapshot(sender)).score} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  const sendersSection =
    senders.length > 0 ? (
      <section aria-label="Senders" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Senders</h2>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search senders…"
            aria-label="Search senders"
            className="min-h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-56"
          />
        </div>

        {shownSenders.length === 0 ? (
          <p className="text-sm text-muted">No senders match “{query}”.</p>
        ) : desktop ? (
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="py-2 pr-4 font-medium">Sender</th>
                <th className="py-2 pr-4 font-medium">Domain</th>
                <th className="py-2 pr-4 font-medium">Category</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Emails</th>
              </tr>
            </thead>
            <tbody>
              {shownSenders.map((sender) => (
                <tr
                  key={sender.id}
                  tabIndex={0}
                  onClick={() => setSelected(sender)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") setSelected(sender);
                  }}
                  className="cursor-pointer border-b border-line transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                >
                  <td className="py-2 pr-4 font-medium text-ink">{sender.email}</td>
                  <td className="py-2 pr-4 text-muted">{sender.domain}</td>
                  <td className="py-2 pr-4 text-muted">{sender.category}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={statusTone(sender.trustStatus)}>{sender.trustStatus}</Badge>
                  </td>
                  <td className="py-2 text-right tabular-nums">{sender.totalEmails}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="space-y-2">
            {shownSenders.map((sender) => (
              <li key={sender.id}>
                <button
                  type="button"
                  onClick={() => setSelected(sender)}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{sender.email}</p>
                    <p className="truncate text-xs text-muted">
                      {sender.category} · {sender.totalEmails} emails
                    </p>
                  </div>
                  <Badge tone={statusTone(sender.trustStatus)}>{sender.trustStatus}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}

        {filteredSenders.length > shownSenders.length && (
          <p className="text-xs text-muted">
            Showing {shownSenders.length} of {filteredSenders.length}. Search to narrow.
          </p>
        )}
      </section>
    ) : null;

  return (
    <div className={`mx-auto flex flex-col gap-6 px-4 py-8 ${desktop ? "max-w-6xl" : "max-w-3xl"}`}>
      {heroCard}

      <section className="grid grid-cols-3 gap-3" aria-label="Summary">
        <Stat label="Senders" value={senders.length} />
        <Stat label="Domains" value={domains.length} />
        <Stat
          label="Pending"
          value={openPrompts.length}
          onClick={openPrompts.length > 0 ? onStartWorkflow : undefined}
        />
      </section>

      {desktop && pendingSection !== null ? (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-start gap-6">
          {sendersSection}
          {pendingSection}
        </div>
      ) : (
        <>
          {pendingSection}
          {sendersSection}
        </>
      )}

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
