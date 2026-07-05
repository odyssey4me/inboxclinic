// SPDX-License-Identifier: Apache-2.0
import {
  computeTrustScore,
  healthInputFromSenders,
  inboxHealthScore,
  senderToSnapshot,
  type Sender,
  type Store,
} from "@inboxclinic/core";

import { ScoreIndicator } from "../components/composed/ScoreIndicator";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ProgressBar } from "../components/ui/ProgressBar";
import { useStoreSnapshot } from "../hooks/useStoreSnapshot";
import { useLayout } from "../layout/context";
import { healthTone } from "../lib/health";

export interface DashboardProps {
  store: Store;
  onStartWorkflow: () => void;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="text-center">
      <p className="text-2xl font-bold tabular-nums text-ink">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </Card>
  );
}

/** Trust status as a colour-coded chip (colour is always paired with the status word). */
function statusTone(status: Sender["trustStatus"]): BadgeTone {
  if (status === "trusted") return "green";
  if (status === "blocked") return "red";
  return "neutral";
}

/** Dashboard: inbox-health hero + next action, counts, top pending prompts, sender list. */
export function Dashboard({ store, onStartWorkflow }: DashboardProps) {
  const { data } = useStoreSnapshot(store);
  const { layout } = useLayout();
  const desktop = layout === "desktop";

  const senders = data?.senders ?? [];
  const domains = data?.domains ?? [];
  const openPrompts = (data?.prompts ?? []).filter((p) => p.resolvedAt === null);
  const senderById = new Map(senders.map((s) => [s.id, s]));

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
            <li
              key={sender.id}
              className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm"
            >
              <span className="truncate font-medium text-ink">{sender.email}</span>
              <ScoreIndicator score={computeTrustScore(senderToSnapshot(sender)).score} />
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  const sendersSection =
    senders.length > 0 ? (
      <section aria-label="Senders" className="space-y-2">
        <h2 className="text-lg font-semibold">Senders</h2>
        {desktop ? (
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
              {senders.map((sender) => (
                <tr key={sender.id} className="border-b border-line">
                  <td className="py-2 pr-4">{sender.email}</td>
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
            {senders.map((sender) => (
              <li
                key={sender.id}
                className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{sender.email}</p>
                  <p className="truncate text-xs text-muted">
                    {sender.category} · {sender.totalEmails} emails
                  </p>
                </div>
                <Badge tone={statusTone(sender.trustStatus)}>{sender.trustStatus}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    ) : null;

  return (
    <div className={`mx-auto flex flex-col gap-6 px-4 py-8 ${desktop ? "max-w-6xl" : "max-w-3xl"}`}>
      {heroCard}

      <section className="grid grid-cols-3 gap-3" aria-label="Summary">
        <Stat label="Senders" value={senders.length} />
        <Stat label="Domains" value={domains.length} />
        <Stat label="Pending" value={openPrompts.length} />
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
    </div>
  );
}
