// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  enforce,
  keyFor,
  simulateEnforcement,
  type BlockAction,
  type Decision,
  type DecisionScope,
  type GmailClient,
  type Sender,
  type SimulatedImpact,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

import { Button } from "../ui/Button";
import { Drawer } from "../ui/Drawer";
import { ImpactPreview } from "./ImpactPreview";
import { PromptCard } from "./PromptCard";
import { TrustActions } from "./TrustActions";

export interface SenderDetailProps {
  /** The sender to act on, or null to close the drawer. */
  sender: Sender | null;
  store: Store;
  gmail: GmailClient;
  online: boolean;
  onClose: () => void;
  /** Called after a decision is applied so the caller can refresh. */
  onChanged: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A drawer (right panel on desktop, bottom sheet on mobile) that shows a sender's
 * evidence and lets the user act on it directly — Trust/Defer apply immediately (safe),
 * while Block shows the impact preview + confirm first (it can archive/delete mail). The
 * same detail+action surface used from the Dashboard so any sender is actionable in place.
 */
export function SenderDetail({
  sender,
  store,
  gmail,
  online,
  onClose,
  onChanged,
}: SenderDetailProps) {
  const [scope, setScope] = useState<DecisionScope>("address");
  const [confirmBlock, setConfirmBlock] = useState<{ actions: BlockAction[] } | null>(null);
  const [impact, setImpact] = useState<SimulatedImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the transient state whenever a different sender is opened.
  useEffect(() => {
    setScope("address");
    setConfirmBlock(null);
    setImpact(null);
    setError(null);
  }, [sender?.id]);

  if (sender === null) return null;

  const subjectId = scope === "domain" ? keyFor(sender.domain) : sender.id;

  const commit = async (decision: Decision, actions: BlockAction[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await applyDecision(store, {
        subjectId,
        scope,
        decision,
        actions,
        decidedVia: "dashboard",
        now: Date.now(),
      });
      await enforce(gmail, store);
      onChanged();
      onClose();
    } catch (caught) {
      setError(`Could not apply: ${errorMessage(caught)}`);
      setBusy(false);
    }
  };

  const onDecide = async (decision: Decision, actions: BlockAction[]): Promise<void> => {
    // Block can archive/delete existing mail — preview + confirm first. Trust/Defer are safe.
    if (decision === "block") {
      setConfirmBlock({ actions });
      setImpact(null);
      setImpact(
        await simulateEnforcement(gmail, store, [{ subjectId, scope, decision: "block", actions }]),
      );
      return;
    }
    await commit(decision, []);
  };

  return (
    <Drawer label={`Actions for ${sender.email}`} title="Sender" onClose={onClose}>
      <PromptCard sender={sender} />

      {confirmBlock === null ? (
        <TrustActions
          sender={sender}
          scope={scope}
          onScopeChange={setScope}
          canScopeDomain
          onDecide={onDecide}
        />
      ) : (
        <div className="space-y-3">
          <ImpactPreview impact={impact} />
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={() => void commit("block", confirmBlock.actions)}
              disabled={busy || impact === null || !online}
            >
              {busy ? "Applying…" : "Confirm block"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmBlock(null)} disabled={busy}>
              Back
            </Button>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-block">
          {error}
        </p>
      )}
    </Drawer>
  );
}
