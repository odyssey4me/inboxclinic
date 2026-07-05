// SPDX-License-Identifier: Apache-2.0
import { computeTrustScore, senderToSnapshot, type Sender, type Store } from "@inboxclinic/core";

import { ScoreIndicator } from "../components/composed/ScoreIndicator";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useStoreSnapshot } from "../hooks/useStoreSnapshot";

export interface DashboardProps {
  store: Store;
  onStartWorkflow: () => void;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="text-center">
      <p className="text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </Card>
  );
}

/** Dashboard: counts, top pending prompts, and the sender list. */
export function Dashboard({ store, onStartWorkflow }: DashboardProps) {
  const { data } = useStoreSnapshot(store);

  const senders = data?.senders ?? [];
  const domains = data?.domains ?? [];
  const openPrompts = (data?.prompts ?? []).filter((p) => p.resolvedAt === null);
  const senderById = new Map(senders.map((s) => [s.id, s]));

  const topPending = [...openPrompts]
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .map((p) => senderById.get(p.senderId))
    .filter((s): s is Sender => s !== undefined)
    .slice(0, 3);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <section className="grid grid-cols-3 gap-3" aria-label="Summary">
        <Stat label="Senders" value={senders.length} />
        <Stat label="Domains" value={domains.length} />
        <Stat label="Pending" value={openPrompts.length} />
      </section>

      {openPrompts.length > 0 && (
        <section className="space-y-3" aria-label="Pending decisions">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Pending decisions</h2>
            <Button onClick={onStartWorkflow}>Review {openPrompts.length}</Button>
          </div>
          <ul className="space-y-2">
            {topPending.map((sender) => (
              <li
                key={sender.id}
                className="flex items-center justify-between rounded-md border border-slate-100 px-3 py-2 text-sm"
              >
                <span className="truncate font-medium text-slate-800">{sender.email}</span>
                <ScoreIndicator score={computeTrustScore(senderToSnapshot(sender)).score} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {senders.length > 0 && (
        <section aria-label="Senders">
          <h2 className="mb-2 text-lg font-semibold">Senders</h2>
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-300 text-slate-500">
                <th className="py-2 pr-4 font-medium">Sender</th>
                <th className="py-2 pr-4 font-medium">Domain</th>
                <th className="py-2 pr-4 font-medium">Category</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Emails</th>
              </tr>
            </thead>
            <tbody>
              {senders.map((sender) => (
                <tr key={sender.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4">{sender.email}</td>
                  <td className="py-2 pr-4 text-slate-500">{sender.domain}</td>
                  <td className="py-2 pr-4 text-slate-500">{sender.category}</td>
                  <td className="py-2 pr-4 text-slate-500">{sender.trustStatus}</td>
                  <td className="py-2 text-right tabular-nums">{sender.totalEmails}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
