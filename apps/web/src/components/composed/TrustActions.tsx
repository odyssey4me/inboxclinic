// SPDX-License-Identifier: Apache-2.0
import {
  defaultBlockActions,
  type BlockAction,
  type Decision,
  type DecisionScope,
  type Sender,
} from "@inboxclinic/core";
import { useState } from "react";

import { Button } from "../ui/Button";

const ALL_ACTIONS: { id: BlockAction; label: string }[] = [
  { id: "unsubscribe", label: "Unsubscribe" },
  { id: "create_filter", label: "Create filter" },
  { id: "archive", label: "Archive existing" },
  { id: "delete", label: "Delete existing" },
];

export interface TrustActionsProps {
  sender: Sender;
  scope: DecisionScope;
  onScopeChange: (scope: DecisionScope) => void;
  canScopeDomain: boolean;
  onDecide: (decision: Decision, actions: BlockAction[]) => void;
}

/** Decision phase: Trust / Block (with action checkboxes) / Defer + a scope toggle. */
export function TrustActions({
  sender,
  scope,
  onScopeChange,
  canScopeDomain,
  onDecide,
}: TrustActionsProps) {
  const [blockOpen, setBlockOpen] = useState(false);
  const [actions, setActions] = useState<BlockAction[]>(() => defaultBlockActions(sender));

  const toggle = (id: BlockAction): void =>
    setActions((current) =>
      current.includes(id) ? current.filter((a) => a !== id) : [...current, id],
    );

  return (
    <div className="space-y-4">
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">Decision scope</legend>
        <span className="text-sm text-muted">Apply to:</span>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="radio"
            name="scope"
            checked={scope === "address"}
            onChange={() => onScopeChange("address")}
          />
          This address
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="radio"
            name="scope"
            checked={scope === "domain"}
            disabled={!canScopeDomain}
            onChange={() => onScopeChange("domain")}
          />
          Whole domain ({sender.domain})
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="trust" onClick={() => onDecide("trust", [])}>
          Trust
        </Button>
        {/* One tap blocks with smart defaults; the impact is shown in Review before it applies. */}
        <Button variant="danger" onClick={() => onDecide("block", defaultBlockActions(sender))}>
          Block
        </Button>
        <Button variant="ghost" onClick={() => onDecide("defer", [])}>
          Not sure (defer)
        </Button>
        <button
          type="button"
          onClick={() => setBlockOpen((v) => !v)}
          aria-expanded={blockOpen}
          className="text-xs font-medium text-muted underline underline-offset-2 hover:text-ink"
        >
          Customize block
        </button>
      </div>

      {blockOpen && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <p className="text-sm font-medium text-ink">Actions to stage (applied later):</p>
          <div className="space-y-1">
            {ALL_ACTIONS.map(({ id, label }) => {
              const disabled = id === "unsubscribe" && !sender.hasListUnsubscribe;
              return (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={actions.includes(id)}
                    disabled={disabled}
                    onChange={() => toggle(id)}
                  />
                  <span className={disabled ? "text-muted" : "text-ink"}>{label}</span>
                </label>
              );
            })}
          </div>
          <Button variant="danger" onClick={() => onDecide("block", actions)}>
            Block with these actions
          </Button>
        </div>
      )}
    </div>
  );
}
