// SPDX-License-Identifier: Apache-2.0
import {
  defaultBlockActions,
  type BlockAction,
  type Decision,
  type DecisionScope,
  type ParentDomainCoverage,
  type Sender,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

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
  /**
   * What a whole-subtree rule would cover, when one is worth offering (the sender is on a
   * subdomain, and other domains under the same registrable domain have been seen). Absent
   * means no third option: offering "all of example.com" while looking at example.com itself
   * would be the same decision wearing a broader-sounding name.
   */
  parentCoverage?: ParentDomainCoverage | undefined;
  onDecide: (decision: Decision, actions: BlockAction[]) => void;
}

/** Decision phase: Trust / Block (with action checkboxes) / Defer + a scope toggle. */
export function TrustActions({
  sender,
  scope,
  onScopeChange,
  canScopeDomain,
  parentCoverage,
  onDecide,
}: TrustActionsProps) {
  const [blockOpen, setBlockOpen] = useState(false);
  const [actions, setActions] = useState<BlockAction[]>(() => defaultBlockActions(sender));

  // This component instance is reused across senders (no remount on prop change), so
  // reset the staged selection here — otherwise a prior sender's customized actions could
  // be applied to this one.
  useEffect(() => {
    setBlockOpen(false);
    setActions(defaultBlockActions(sender));
  }, [sender]);

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
        {parentCoverage !== undefined && (
          <label className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              name="scope"
              checked={scope === "parentDomain"}
              onChange={() => onScopeChange("parentDomain")}
            />
            All {parentCoverage.registrable} subdomains (
            {parentCoverage.subtree.filter((d) => d.domain !== parentCoverage.registrable).length})
          </label>
        )}
      </fieldset>

      {/* Breadth is stated BEFORE the decision, not explained after it: this scope reaches
          further than its name suggests, and the surprising part is the siblings. */}
      {scope === "parentDomain" && parentCoverage !== undefined && (
        <div className="space-y-1 rounded-md bg-accent-soft px-3 py-3 text-sm text-accent-ink">
          <p className="font-medium">
            This covers every sender at {parentCoverage.registrable} and below —{" "}
            {parentCoverage.senderCount} seen so far:
          </p>
          <ul className="list-disc pl-5">
            {parentCoverage.subtree.map((d) => (
              <li key={d.domain}>
                {d.domain} ({d.senderCount})
              </li>
            ))}
          </ul>
          {parentCoverage.siblings.length > 0 && (
            <>
              <p className="font-medium text-block">
                From what we have observed of Gmail&rsquo;s matching, it will also catch these — NOT
                part of {parentCoverage.registrable}, and possibly unrelated:
              </p>
              <ul className="list-disc pl-5 text-block">
                {parentCoverage.siblings.map((d) => (
                  <li key={d.domain}>
                    {d.domain} ({d.senderCount})
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-xs">
            Anything new under {parentCoverage.registrable} is covered too, by design. The part
            worth weighing is the other kind: a domain like {parentCoverage.registrable}.xx, owned
            by someone else, that has not written yet and so cannot be listed here. Decide a domain
            separately afterwards to carve it back out.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="trust" onClick={() => onDecide("trust", [])}>
          Trust
        </Button>
        {/* One tap blocks with smart defaults; the impact is shown in Review before it applies. */}
        <Button variant="danger" onClick={() => onDecide("block", defaultBlockActions(sender))}>
          Block
        </Button>
        {/* Defer is only meaningful for an undecided subject — applyDecision is a no-op
            once trusted/blocked (design-trust-decisions.md), so hide it once decided. */}
        {sender.trustStatus === "pending" && (
          <Button variant="ghost" onClick={() => onDecide("defer", [])}>
            Not sure (defer)
          </Button>
        )}
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
