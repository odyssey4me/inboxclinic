// SPDX-License-Identifier: Apache-2.0
import { computeTrustScore, senderToSnapshot, type Sender } from "@inboxclinic/core";

import { Card } from "../ui/Card";
import { ScoreIndicator } from "./ScoreIndicator";
import { SignalList } from "./SignalList";

function readRateLabel(readRate: number | null): string {
  if (readRate === null) return "unknown";
  return `${Math.round(readRate * 100)}%`;
}

/** Discovery: a sender's identity, trust score, key signals, and evidence. */
export function PromptCard({ sender }: { sender: Sender }) {
  const result = computeTrustScore(senderToSnapshot(sender));

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            {sender.displayName ?? sender.email}
          </h2>
          <p className="text-sm text-slate-500">{sender.email}</p>
        </div>
        <ScoreIndicator score={result.score} />
      </div>

      <SignalList signals={result.signals} />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-400">Read rate</dt>
          <dd className="font-medium text-slate-800">{readRateLabel(sender.readRate)}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Emails</dt>
          <dd className="font-medium text-slate-800">{sender.totalEmails}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Frequency</dt>
          <dd className="font-medium text-slate-800">{sender.frequency}</dd>
        </div>
        <div>
          <dt className="text-slate-400">Category</dt>
          <dd className="font-medium text-slate-800">{sender.category}</dd>
        </div>
      </dl>
    </Card>
  );
}
