// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  defaultBlockActions,
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
  /** Same-domain senders that also carry a prior-block signal and are still pending (#96). */
  flaggedSiblings?: Sender[];
  store: Store;
  gmail: GmailClient;
  online: boolean;
  onClose: () => void;
  /** Called after a decision is applied so the caller can refresh. */
  onChanged: () => void;
}

/** One subject to act on: its store id, the decision scope, and the sender (for defaults). */
interface Target {
  subjectId: string;
  scope: DecisionScope;
  sender: Sender;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A drawer (right panel on desktop, bottom sheet on mobile) that shows a sender's evidence and
 * lets the user act on it directly — Trust/Defer apply immediately (safe), while Block shows the
 * impact preview + confirm first. When the sender has same-domain **flagged siblings** (already
 * spam/trash/filtered), it also offers to decide them together (design-trust-decisions.md
 * Decision 8): block all flagged, or keep them all.
 */
export function SenderDetail({
  sender,
  flaggedSiblings = [],
  store,
  gmail,
  online,
  onClose,
  onChanged,
}: SenderDetailProps) {
  const [scope, setScope] = useState<DecisionScope>("address");
  // A pending block awaiting confirm — the targets to block + the preview.
  const [confirm, setConfirm] = useState<{
    targets: Target[];
    actions: BlockAction[] | undefined;
  } | null>(null);
  const [impact, setImpact] = useState<SimulatedImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the transient state whenever a different sender is opened.
  useEffect(() => {
    setScope("address");
    setConfirm(null);
    setImpact(null);
    setError(null);
  }, [sender?.id]);

  if (sender === null) return null;

  // The scope-toggle (single-sender domain) path always supplies concrete actions from
  // TrustActions; the fallback only fires for the address-scoped flagged batch.
  const blockActions = (target: Target, actions: BlockAction[] | undefined): BlockAction[] =>
    actions ?? defaultBlockActions(target.sender);

  // Block can archive/delete mail — preview + confirm first (over all targets).
  const previewBlock = async (
    targets: Target[],
    actions: BlockAction[] | undefined,
  ): Promise<void> => {
    setConfirm({ targets, actions });
    setImpact(null);
    setImpact(
      await simulateEnforcement(
        gmail,
        store,
        targets.map((t) => ({
          subjectId: t.subjectId,
          scope: t.scope,
          decision: "block" as const,
          actions: blockActions(t, actions),
        })),
      ),
    );
  };

  const commit = async (
    targets: Target[],
    decision: Decision,
    actions: BlockAction[] | undefined,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Targets here never mix scopes in one commit (a single subject, or same-scope flagged
      // siblings), so no same-batch domain/address ordering hazard applies (#167).
      for (const t of targets) {
        await applyDecision(store, {
          subjectId: t.subjectId,
          scope: t.scope,
          decision,
          actions: decision === "block" ? blockActions(t, actions) : [],
          decidedVia: "dashboard",
          now: Date.now(),
        });
      }
      await enforce(gmail, store);
      onChanged();
      onClose();
    } catch (caught) {
      setError(`Could not apply: ${errorMessage(caught)}`);
      setBusy(false);
    }
  };

  // The single subject from TrustActions (respects the address/domain scope toggle).
  const singleTarget: Target = {
    subjectId: scope === "domain" ? keyFor(sender.domain) : sender.id,
    scope,
    sender,
  };
  // The flagged set: this sender + its flagged same-domain siblings, all address-scoped.
  const flaggedTargets: Target[] = [sender, ...flaggedSiblings].map((s) => ({
    subjectId: s.id,
    scope: "address" as const,
    sender: s,
  }));

  const onDecide = async (decision: Decision, actions: BlockAction[]): Promise<void> => {
    if (decision === "block") return previewBlock([singleTarget], actions);
    await commit([singleTarget], decision, undefined);
  };

  const confirmCount = confirm?.targets.length ?? 0;

  return (
    <Drawer label={`Actions for ${sender.email}`} title="Sender" onClose={onClose}>
      <PromptCard sender={sender} />

      {confirm === null ? (
        <>
          <TrustActions
            sender={sender}
            scope={scope}
            onScopeChange={setScope}
            canScopeDomain
            onDecide={onDecide}
          />

          {flaggedSiblings.length > 0 && (
            <div className="space-y-2 rounded-md bg-accent-soft px-3 py-3 text-sm">
              <p className="text-accent-ink">
                <span className="font-medium">
                  {flaggedSiblings.length} other flagged sender
                  {flaggedSiblings.length === 1 ? "" : "s"}
                </span>{" "}
                on <span className="font-medium">{sender.domain}</span> — already spam/binned or
                filtered. Decide them together?
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  className="px-2 py-1 text-xs"
                  disabled={busy || !online}
                  onClick={() => void previewBlock(flaggedTargets, undefined)}
                >
                  Block all {flaggedTargets.length}
                </Button>
                <Button
                  variant="trust"
                  className="px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => void commit(flaggedTargets, "trust", undefined)}
                >
                  Keep all — they're fine
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  disabled={busy}
                  onClick={() => void commit(flaggedTargets, "defer", undefined)}
                >
                  Not now
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-3">
          {confirmCount > 1 && (
            <p className="text-sm text-muted">Blocking {confirmCount} senders.</p>
          )}
          <ImpactPreview impact={impact} />
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={() => void commit(confirm.targets, "block", confirm.actions)}
              disabled={busy || impact === null || !online}
            >
              {busy ? "Applying…" : confirmCount > 1 ? "Confirm block all" : "Confirm block"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
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
