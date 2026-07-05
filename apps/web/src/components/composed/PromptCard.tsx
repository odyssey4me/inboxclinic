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
          <h2 className="text-lg font-semibold text-ink">{sender.displayName ?? sender.email}</h2>
          <p className="text-sm text-muted">{sender.email}</p>
        </div>
        <ScoreIndicator score={result.score} />
      </div>

      <SignalList signals={result.signals} />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted">Read rate</dt>
          <dd className="font-medium text-ink">{readRateLabel(sender.readRate)}</dd>
        </div>
        <div>
          <dt className="text-muted">Emails</dt>
          <dd className="font-medium text-ink">{sender.totalEmails}</dd>
        </div>
        <div>
          <dt className="text-muted">Frequency</dt>
          <dd className="font-medium text-ink">{sender.frequency}</dd>
        </div>
        <div>
          <dt className="text-muted">Category</dt>
          <dd className="font-medium text-ink">{sender.category}</dd>
        </div>
      </dl>
    </Card>
  );
}
