// SPDX-License-Identifier: Apache-2.0
import type { Decision } from "@inboxclinic/core";

import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import type { PendingDecision } from "../../workflow/pendingDecisions";

const DECISION_TONE = {
  trust: "green",
  block: "red",
  defer: "amber",
} as const;

const DECISIONS: Decision[] = ["trust", "block", "defer"];

export interface DecisionRowProps {
  pending: PendingDecision;
  onChangeDecision: (decision: Decision) => void;
  onRemove: () => void;
}

/** Review: one editable pending change (flip decision, or remove from the batch). */
export function DecisionRow({ pending, onChangeDecision, onRemove }: DecisionRowProps) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{pending.label}</p>
        <p className="text-xs text-muted">
          {pending.scope === "domain" ? "whole domain" : "this address"}
          {pending.decision === "block" && pending.actions.length > 0
            ? ` · ${pending.actions.join(", ")}`
            : ""}
        </p>
      </div>

      <Badge tone={DECISION_TONE[pending.decision]}>{pending.decision}</Badge>

      <div className="flex gap-1" role="group" aria-label={`Change decision for ${pending.label}`}>
        {DECISIONS.map((decision) => (
          <Button
            key={decision}
            variant={decision === pending.decision ? "secondary" : "ghost"}
            className="px-2 py-1"
            aria-pressed={decision === pending.decision}
            onClick={() => onChangeDecision(decision)}
          >
            {decision}
          </Button>
        ))}
      </div>

      <Button variant="ghost" className="px-2 py-1 text-block" onClick={onRemove}>
        Remove
      </Button>
    </li>
  );
}
