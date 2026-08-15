// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  defaultBlockActions,
  enforce,
  keyFor,
  coveringRulesFor,
  domainBlockCoverage,
  parentDomainCoverage,
  resolveSenderGovernance,
  simulateEnforcement,
  withdrawDecision,
  type BlockAction,
  type Decision,
  type DecisionScope,
  type Domain,
  type GmailClient,
  type Sender,
  type SimulatedImpact,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

import { scheduleBackup } from "../../backup/autoBackup";
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
  /**
   * Every observed sender, used to work out what a whole-subtree rule would cover and to
   * state that breadth before the decision (design-trust-decisions.md Decision 9).
   */
  allSenders?: Sender[];
  /**
   * Every known domain record, so the rule governing this sender can be found and named.
   * Without it a sender decided by a rule reads as decided by nobody — the same gap #186
   * closed for domains, one level down (#229).
   */
  allDomains?: Domain[];
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
  allSenders = [],
  allDomains = [],
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

  // Offer the subtree scope only where it means something more than the domain scope already
  // does: the sender must sit BELOW its registrable domain, and other domains under that name
  // must have been seen. On `example.com` itself, "all example.com subdomains" would be the
  // same decision with a broader-sounding label, which is how a user ends up making a wider
  // choice than they realised.
  const coverage = parentDomainCoverage(sender.domain, allSenders);
  const parentCoverage =
    coverage !== null &&
    coverage.registrable !== sender.domain.toLowerCase() &&
    coverage.subtree.length > 1
      ? coverage
      : undefined;

  // What the plain DOMAIN scope reaches. `*@domain` spans the subtree (#210), so this states
  // the breadth before the decision instead of leaving it to be discovered from behaviour.
  // Carve-outs are the subdomains already TRUSTED — the set `effectiveBlockedDomains` excludes,
  // so the panel promises exactly what enforcement will do.
  const domainCoverage = domainBlockCoverage(
    sender.domain,
    allSenders,
    allDomains.filter((d) => d.trustStatus === "trusted").map((d) => d.domain),
  );

  // The rule governing this sender from above, and whether it has already been carved out of
  // it — the answer to "why is this blocked when I never decided it?" (#229). Deliberately a
  // single line rather than DomainDetail's panel: making the carve-out is what the Trust/Block
  // buttons below already do at address scope, so only *rejoining* needs a control of its own.
  // `resolveSenderGovernance` is the one copy of the precedence ladder (#238) — it also picks up
  // a domain-scope block's subtree reach via `coveringRulesFor` (#244), which a rule keyed only
  // on `parentDomainRuleFor` would miss.
  const domainsByKey = new Map(allDomains.map((d) => [keyFor(d.domain), d]));
  const exactRule = domainsByKey.get(keyFor(sender.domain));
  const { governingRule, carvedOutOf } = resolveSenderGovernance(
    sender,
    exactRule,
    coveringRulesFor(sender.domain, domainsByKey),
  );
  // A decision of its own that the governing rule overrides: made before the rule existed, since
  // deciding under one records the carve-out. Dormant, but it resurfaces if the rule is removed.
  const overriddenDecision = sender.trustStatus !== "pending" || sender.decisionScope !== null;
  // "…which covers every domain beneath it" — true of a parent-domain rule by design, and of
  // any rule governing this sender from ABOVE, since `*@domain` reaches the subtree (#210/#244).
  // Without the second case a sender at `email.example.com` was told an `example.com` rule
  // blocked it and never told why that rule reached its subdomain at all.
  const ruleIsSubtree =
    governingRule !== undefined &&
    (governingRule.decisionScope === "parentDomain" ||
      governingRule.domain.toLowerCase() !== sender.domain.toLowerCase());

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
      scheduleBackup();
      await enforce(gmail, store);
      onChanged();
      onClose();
    } catch (caught) {
      setError(`Could not apply: ${errorMessage(caught)}`);
      setBusy(false);
    }
  };

  // The single subject from TrustActions (respects the address/domain scope toggle).
  // `parentCoverage` is what makes the parentDomain scope selectable, and it only ever gains
  // senders within a session — so a selected parentDomain scope always has coverage to key on.
  // If senders ever become removable, this fallback would apply a subtree decision to one
  // domain while still labelling it `parentDomain`; guard it there rather than trusting this.
  const singleTarget: Target = {
    subjectId:
      scope === "parentDomain"
        ? keyFor(parentCoverage?.registrable ?? sender.domain)
        : scope === "domain"
          ? keyFor(sender.domain)
          : sender.id,
    scope,
    sender,
  };
  // The flagged set: this sender + its flagged same-domain siblings, all address-scoped.
  const flaggedTargets: Target[] = [sender, ...flaggedSiblings].map((s) => ({
    subjectId: s.id,
    scope: "address" as const,
    sender: s,
  }));

  // Rejoining is not the same as deciding to agree: that would leave the sender individually
  // decided, so a later change to the rule would not reach it. Withdrawing removes the decision
  // and the carve-out together (#225).
  const rejoinRule = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await withdrawDecision(store, { subjectId: sender.id, scope: "address" });
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
          {governingRule !== undefined && (
            <p className="text-sm text-muted">
              {governingRule.trustStatus === "blocked" ? "Blocked" : "Trusted"} by the rule on{" "}
              <span className="font-medium text-ink">{governingRule.domain}</span>
              {ruleIsSubtree ? ", which covers every domain beneath it" : ""} —{" "}
              {overriddenDecision
                ? "it overrides the earlier decision on this address."
                : "no decision was made about this address on its own."}
            </p>
          )}

          {carvedOutOf !== undefined && (
            <p className="text-sm text-muted">
              Carved out of the rule on{" "}
              <span className="font-medium text-ink">{carvedOutOf.domain}</span>: this address keeps
              its own decision.{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => void rejoinRule()}
                className="underline transition-colors hover:text-accent-ink disabled:opacity-50"
              >
                Follow the rule again
              </button>
            </p>
          )}

          <TrustActions
            sender={sender}
            scope={scope}
            onScopeChange={setScope}
            canScopeDomain
            parentCoverage={parentCoverage}
            domainCoverage={domainCoverage}
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
