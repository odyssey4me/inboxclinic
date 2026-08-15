// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  computeTrustScore,
  domainBlockCoverage,
  enforce,
  senderToSnapshot,
  simulateEnforcement,
  withdrawDecision,
  keyFor,
  parentDomainRuleFor,
  type BlockAction,
  type Decision,
  type Domain,
  type GmailClient,
  type Sender,
  type SimulatedImpact,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

import { scheduleBackup } from "../../backup/autoBackup";
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
  /**
   * Every known domain record, so a whole-subtree rule covering this one can be found and
   * named. Without it a domain decided by a rule reads as decided by nobody: the breadth was
   * stated once, when the rule was made, and never again (design-trust-decisions.md D9).
   */
  allDomains?: Domain[];
  /** The domain's member senders (joined on `sender.domain`). */
  members: Sender[];
  /**
   * Every observed sender, so the breadth of this block can be stated before it is made.
   * `members` cannot serve: it joins on the exact domain, while a domain block reaches the
   * whole subtree (#210) — the senders it would additionally catch are precisely the ones
   * `members` leaves out. Defaults to `members`, which understates rather than overstates.
   */
  allSenders?: Sender[];
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
  allSenders,
  allDomains = [],
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

  // The rule governing this domain from above, if any — and whether it has already been
  // carved out of it. This is the answer to "why is this blocked when I never decided it?",
  // which nothing in the UI could give once the decision moment had passed.
  const domainsByKey = new Map(allDomains.map((d) => [keyFor(d.domain), d]));
  const parentRule = parentDomainRuleFor(domain.domain, domainsByKey);
  const carvedOut = parentRule?.exceptionDomains.includes(domain.domain) ?? false;
  const governedByParent =
    parentRule !== undefined && parentRule.trustStatus !== "pending" && !carvedOut;

  // What blocking this domain would actually reach, and which subdomains enforcement will
  // spare because the user already decided them (#210).
  const domainCoverage = domainBlockCoverage(
    domain.domain,
    allSenders ?? members,
    allDomains.filter((d) => d.trustStatus === "trusted").map((d) => d.domain),
  );

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
      scheduleBackup();
      await enforce(gmail, store);
      onChanged();
      onClose();
    } catch (caught) {
      setError(`Could not apply: ${errorMessage(caught)}`);
      setBusy(false);
    }
  };

  const rejoinParentRule = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await withdrawDecision(store, { subjectId, scope: "domain" });
      scheduleBackup();
      // The effective status can move either way, so reconcile rather than assume.
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

        {parentRule !== undefined && parentRule.trustStatus !== "pending" && (
          <div className="space-y-2 rounded-md bg-accent-soft px-3 py-3 text-sm text-accent-ink">
            {governedByParent ? (
              <>
                <p>
                  <span className="font-medium">
                    {parentRule.trustStatus === "blocked" ? "Blocked" : "Trusted"} by the rule on{" "}
                    {parentRule.domain}
                  </span>{" "}
                  — which covers every domain beneath it, including this one. No decision was made
                  about {domain.domain} on its own.
                </p>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    commit(parentRule.trustStatus === "blocked" ? "trust" : "block", [])
                  }
                >
                  {parentRule.trustStatus === "blocked" ? "Keep this one" : "Block this one"}
                </Button>
              </>
            ) : (
              <>
                <p>
                  Carved out of the rule on {parentRule.domain}: this domain keeps its own decision,
                  and the rule no longer applies to it.
                </p>
                {/* Rejoining is not the same as deciding to agree: that would leave this
                    domain individually decided, so a later change to the rule would not
                    reach it. Withdrawing removes the decision and the carve-out together. */}
                <Button variant="ghost" disabled={busy} onClick={rejoinParentRule}>
                  Follow the rule on {parentRule.domain} again
                </Button>
              </>
            )}
          </div>
        )}

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
          {/* Breadth before the decision, not after it: `*@domain` spans the subtree (#210),
              so "Block domain" reaches senders this drawer never listed — `members` joins on
              the exact domain, which is exactly the set that hides them. */}
          {(domainCoverage.covered.length > 1 || domainCoverage.carvedOut.length > 0) && (
            <div className="space-y-1 rounded-md bg-accent-soft px-3 py-3 text-sm text-accent-ink">
              <p className="font-medium">
                Blocking {domain.domain} also covers everything beneath it —{" "}
                {domainCoverage.senderCount} sender
                {domainCoverage.senderCount === 1 ? "" : "s"} seen so far:
              </p>
              <ul className="list-disc pl-5">
                {domainCoverage.covered.map((d) => (
                  <li key={d.domain}>
                    {d.domain} ({d.senderCount})
                  </li>
                ))}
              </ul>
              {domainCoverage.carvedOut.length > 0 && (
                <>
                  <p className="font-medium text-trust">
                    Not these — you decided them separately, and they stay decided:
                  </p>
                  <ul className="list-disc pl-5 text-trust">
                    {domainCoverage.carvedOut.map((d) => (
                      <li key={d.domain}>
                        {d.domain} ({d.senderCount})
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="text-xs">
                Anything new under {domain.domain} is covered too, including subdomains that have
                not written yet and so cannot be listed here. Decide one separately afterwards to
                carve it back out.
              </p>
            </div>
          )}
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
