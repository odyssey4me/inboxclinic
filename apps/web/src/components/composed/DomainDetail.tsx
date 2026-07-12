// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  computeTrustScore,
  enforce,
  senderToSnapshot,
  simulateEnforcement,
  type BlockAction,
  type Decision,
  type Domain,
  type GmailClient,
  type Sender,
  type SimulatedImpact,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Drawer } from "../ui/Drawer";
import { ImpactPreview } from "./ImpactPreview";
import { ScoreIndicator } from "./ScoreIndicator";
import { statusTone } from "../../lib/statusTone";

export interface DomainDetailProps {
  /** The domain to act on, or null to close the drawer. */
  domain: Domain | null;
  /** The domain's member senders (joined on `sender.domain`). */
  members: Sender[];
  store: Store;
  gmail: GmailClient;
  online: boolean;
  onClose: () => void;
  /** Drill into a single sender's detail (closes this drawer). */
  onOpenSender: (sender: Sender) => void;
  /** Called after a decision is applied so the caller can refresh. */
  onChanged: () => void;
}

/** Existing-mail actions offered when blocking a whole domain (new mail is always filtered). */
const EXISTING_ACTIONS: { id: BlockAction; label: string }[] = [
  { id: "archive", label: "Archive existing" },
  { id: "delete", label: "Delete existing" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Average member trust score — the established stand-in for a domain-level score. */
function averageScore(members: Sender[]): number | null {
  if (members.length === 0) return null;
  const sum = members.reduce((acc, m) => acc + computeTrustScore(senderToSnapshot(m)).score, 0);
  return sum / members.length;
}

/**
 * A drawer for acting on a whole domain (right panel on desktop, bottom sheet on mobile).
 * Shows the domain aggregate and its member senders (each drillable into SenderDetail), and
 * applies a domain-scoped decision. Trust/Defer apply immediately; Block always filters new
 * mail and previews + confirms before touching existing mail — mirroring SenderDetail.
 */
export function DomainDetail({
  domain,
  members,
  store,
  gmail,
  online,
  onClose,
  onOpenSender,
  onChanged,
}: DomainDetailProps) {
  const [existing, setExisting] = useState<BlockAction[]>([]);
  const [confirmBlock, setConfirmBlock] = useState<{ actions: BlockAction[] } | null>(null);
  const [impact, setImpact] = useState<SimulatedImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state whenever a different domain is opened.
  useEffect(() => {
    setExisting([]);
    setConfirmBlock(null);
    setImpact(null);
    setError(null);
  }, [domain?.id]);

  if (domain === null) return null;

  const subjectId = domain.id;
  const score = averageScore(members);

  const commit = async (decision: Decision, actions: BlockAction[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await applyDecision(store, {
        subjectId,
        scope: "domain",
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

  const onBlock = async (): Promise<void> => {
    // Blocking a domain filters all new mail (create_filter); existing mail is opt-in.
    const actions: BlockAction[] = ["create_filter", ...existing];
    setConfirmBlock({ actions });
    setImpact(null);
    setImpact(
      await simulateEnforcement(gmail, store, [
        { subjectId, scope: "domain", decision: "block", actions },
      ]),
    );
  };

  const toggleExisting = (id: BlockAction): void =>
    setExisting((current) =>
      current.includes(id) ? current.filter((a) => a !== id) : [...current, id],
    );

  return (
    <Drawer label={`Actions for ${domain.domain}`} title="Domain" onClose={onClose}>
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-ink">{domain.domain}</h2>
            <p className="text-sm text-muted">
              {domain.senderCount} sender{domain.senderCount === 1 ? "" : "s"} ·{" "}
              {domain.totalEmails} emails
            </p>
          </div>
          {score !== null ? (
            <ScoreIndicator score={score} />
          ) : (
            <Badge tone={statusTone(domain.trustStatus)}>{domain.trustStatus}</Badge>
          )}
        </div>

        {members.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Senders</p>
            <ul className="divide-y divide-line">
              {members.map((sender) => (
                <li key={sender.id}>
                  <button
                    type="button"
                    onClick={() => onOpenSender(sender)}
                    className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm transition-colors hover:text-accent-ink"
                  >
                    <span className="truncate text-ink">{sender.email}</span>
                    <span className="shrink-0 tabular-nums text-muted">{sender.totalEmails} ›</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {confirmBlock === null ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="trust" onClick={() => void commit("trust", [])} disabled={busy}>
              Trust domain
            </Button>
            <Button variant="danger" onClick={() => void onBlock()} disabled={busy || !online}>
              Block domain
            </Button>
            <Button variant="ghost" onClick={() => void commit("defer", [])} disabled={busy}>
              Not sure (defer)
            </Button>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-xs text-muted">
              Blocking filters all new mail from {domain.domain}. Also apply to existing:
            </legend>
            {EXISTING_ACTIONS.map(({ id, label }) => (
              <label key={id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={existing.includes(id)}
                  onChange={() => toggleExisting(id)}
                />
                <span className="text-ink">{label}</span>
              </label>
            ))}
          </fieldset>
        </div>
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
