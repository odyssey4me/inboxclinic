// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  defaultBlockActions,
  enforce,
  estimateWeeklyVolume,
  keyFor,
  simulateEnforcement,
  type BlockAction,
  type Decision,
  type DecisionScope,
  type EnforceResult,
  type GmailClient,
  type Sender,
  type SimulatedImpact,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { BatchOffer } from "../components/composed/BatchOffer";
import { DecisionRow } from "../components/composed/DecisionRow";
import { ImpactPreview } from "../components/composed/ImpactPreview";
import { PromptCard } from "../components/composed/PromptCard";
import { TrustActions } from "../components/composed/TrustActions";
import { Button } from "../components/ui/Button";
import { ProgressBar } from "../components/ui/ProgressBar";
import { useStoreSnapshot } from "../hooks/useStoreSnapshot";
import type { PendingDecision } from "./pendingDecisions";

type Phase = "triage" | "review" | "execution";

const PHASE_LABELS: { id: Phase; label: string }[] = [
  { id: "triage", label: "Triage" },
  { id: "review", label: "Review" },
  { id: "execution", label: "Execution" },
];

interface ExecResult {
  label: string;
  status: "applied" | "failed";
}

export interface TrustWorkflowProps {
  store: Store;
  gmail: GmailClient;
  onDone: () => void;
}

/** The four-phase trust-decision workflow (Discovery → Decision → Review → Execution). */
export function TrustWorkflow({ store, gmail, onDone }: TrustWorkflowProps) {
  const { data, reload } = useStoreSnapshot(store);

  const [queue, setQueue] = useState<Sender[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<PendingDecision[]>([]);
  const [phase, setPhase] = useState<Phase>("triage");
  const [scope, setScope] = useState<DecisionScope>("address");

  // Initialise the session queue once from the first loaded snapshot.
  useEffect(() => {
    if (data === null || queue !== null) return;
    const senderById = new Map(data.senders.map((s) => [s.id, s]));
    const ordered = data.prompts
      .filter((p) => p.resolvedAt === null)
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .map((p) => senderById.get(p.senderId))
      .filter((s): s is Sender => s !== undefined);
    setQueue(ordered);
  }, [data, queue]);

  const domainSize = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sender of queue ?? [])
      counts.set(sender.domain, (counts.get(sender.domain) ?? 0) + 1);
    return counts;
  }, [queue]);

  if (data === null || queue === null) {
    return <p className="p-6 text-center text-muted">Loading…</p>;
  }

  const current = cursor < queue.length ? queue[cursor] : undefined;

  function nextUnhandled(from: number, skipIds: Set<string>): number {
    for (let i = from; i < queue!.length; i += 1) {
      const sender = queue![i];
      if (sender !== undefined && !skipIds.has(sender.id)) return i;
    }
    return queue!.length;
  }

  function advanceAfter(coveredIds: string[]): void {
    const nextHandled = new Set(handled);
    for (const id of coveredIds) nextHandled.add(id);
    setHandled(nextHandled);
    const next = nextUnhandled(cursor + 1, nextHandled);
    if (next >= queue!.length) {
      setPhase("review");
    } else {
      setCursor(next);
      setScope("address");
      setPhase("triage");
    }
  }

  function decide(decision: Decision, actions: BlockAction[]): void {
    if (current === undefined) return;
    const covered =
      scope === "domain"
        ? queue!.filter((s) => s.domain === current.domain).map((s) => s.id)
        : [current.id];
    const entry: PendingDecision = {
      subjectId: scope === "domain" ? keyFor(current.domain) : current.id,
      scope,
      decision,
      actions,
      label: scope === "domain" ? current.domain : current.email,
      coveredSenderIds: covered,
    };
    setPending((list) => [...list.filter((p) => p.subjectId !== entry.subjectId), entry]);
    advanceAfter(covered);
  }

  function skip(): void {
    if (current === undefined) return;
    advanceAfter([current.id]);
  }

  function changeDecision(subjectId: string, decision: Decision): void {
    setPending((list) =>
      list.map((p) =>
        p.subjectId === subjectId
          ? { ...p, decision, actions: decision === "block" ? p.actions : [] }
          : p,
      ),
    );
  }

  function removePending(entry: PendingDecision): void {
    setPending((list) => list.filter((p) => p.subjectId !== entry.subjectId));
    setHandled((prev) => {
      const next = new Set(prev);
      for (const id of entry.coveredSenderIds) next.delete(id);
      return next;
    });
  }

  const trusted = pending.filter((p) => p.decision === "trust").length;
  const blocked = pending.filter((p) => p.decision === "block").length;
  const deferred = pending.filter((p) => p.decision === "defer").length;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-8">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight">Trust decisions</h2>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </header>

      <ol className="flex items-center gap-2 text-xs" aria-label="Workflow progress">
        {PHASE_LABELS.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.id === phase ? "step" : undefined}
            className={step.id === phase ? "font-semibold text-ink" : "text-muted"}
          >
            {index + 1}. {step.label}
          </li>
        ))}
      </ol>

      {phase === "triage" && queue.length > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted">
            <span>
              Sender {Math.min(handled.size + 1, queue.length)} of {queue.length}
            </span>
            <span>{queue.length - handled.size} left</span>
          </div>
          <ProgressBar value={handled.size} max={queue.length} label="Triage progress" />
        </div>
      )}

      {phase === "triage" && current !== undefined && (
        <section className="space-y-4" aria-label="Triage">
          <PromptCard sender={current} />
          <BatchOffer
            domain={current.domain}
            batchSize={domainSize.get(current.domain) ?? 1}
            onReviewAsGroup={() => setScope("domain")}
          />
          <TrustActions
            sender={current}
            scope={scope}
            onScopeChange={setScope}
            canScopeDomain={(domainSize.get(current.domain) ?? 1) >= 2}
            onDecide={decide}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={skip}>
              Skip for now
            </Button>
            {pending.length > 0 && (
              <Button variant="secondary" onClick={() => setPhase("review")}>
                Review {pending.length} change{pending.length === 1 ? "" : "s"}
              </Button>
            )}
            <span className="ml-auto text-xs text-muted">
              Keys: <kbd>T</kbd> trust · <kbd>B</kbd> block · <kbd>D</kbd> defer · <kbd>S</kbd> skip
            </span>
          </div>
          <TriageKeyboard
            onTrust={() => decide("trust", [])}
            onBlock={() => decide("block", defaultBlockActions(current))}
            onDefer={() => decide("defer", [])}
            onSkip={skip}
          />
        </section>
      )}

      {phase === "review" && (
        <ReviewPhase
          store={store}
          gmail={gmail}
          pending={pending}
          trusted={trusted}
          blocked={blocked}
          deferred={deferred}
          onChangeDecision={changeDecision}
          onRemove={removePending}
          onApply={() => setPhase("execution")}
          onBack={() => {
            const next = nextUnhandled(0, handled);
            if (next < queue.length) {
              setCursor(next);
              setPhase("triage");
            }
          }}
          onDone={onDone}
        />
      )}

      {phase === "execution" && (
        <ExecutionPhase
          store={store}
          gmail={gmail}
          pending={pending}
          onReload={reload}
          onDone={onDone}
        />
      )}
    </div>
  );
}

/** Installs T/B/D/S keyboard shortcuts while a sender is being triaged (mounted in triage). */
function TriageKeyboard({
  onTrust,
  onBlock,
  onDefer,
  onSkip,
}: {
  onTrust: () => void;
  onBlock: () => void;
  onDefer: () => void;
  onSkip: () => void;
}) {
  const handlers = useRef({ onTrust, onBlock, onDefer, onSkip });
  useEffect(() => {
    handlers.current = { onTrust, onBlock, onDefer, onSkip };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const el = event.target as HTMLElement | null;
      if (
        el !== null &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      const map: Record<string, () => void> = {
        t: handlers.current.onTrust,
        b: handlers.current.onBlock,
        d: handlers.current.onDefer,
        s: handlers.current.onSkip,
      };
      const action = map[event.key.toLowerCase()];
      if (action !== undefined) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

interface ReviewPhaseProps {
  store: Store;
  gmail: GmailClient;
  pending: PendingDecision[];
  trusted: number;
  blocked: number;
  deferred: number;
  onChangeDecision: (subjectId: string, decision: Decision) => void;
  onRemove: (entry: PendingDecision) => void;
  onApply: () => void;
  onBack: () => void;
  onDone: () => void;
}

function ReviewPhase({
  store,
  gmail,
  pending,
  trusted,
  blocked,
  deferred,
  onChangeDecision,
  onRemove,
  onApply,
  onBack,
  onDone,
}: ReviewPhaseProps) {
  const [impact, setImpact] = useState<SimulatedImpact | null>(null);
  const [weeklyVolume, setWeeklyVolume] = useState(0);

  // Read-only dry-run of the staged changes (a Gmail search per rule — no mutation) so the
  // user sees the exact impact, especially deletes, before confirming (design Decision 7).
  useEffect(() => {
    let active = true;
    if (pending.length === 0) {
      setImpact(null);
      return;
    }
    void (async () => {
      const simulated = await simulateEnforcement(
        gmail,
        store,
        pending.map((p) => ({
          subjectId: p.subjectId,
          scope: p.scope,
          decision: p.decision,
          actions: p.actions,
        })),
      );
      const senders = await store.senders.query({});
      const byId = new Map(senders.map((s) => [s.id, s]));
      let weekly = 0;
      for (const p of pending) {
        if (p.decision !== "block") continue;
        for (const id of p.coveredSenderIds) {
          const sender = byId.get(id);
          if (sender !== undefined) weekly += estimateWeeklyVolume(sender);
        }
      }
      if (active) {
        setImpact(simulated);
        setWeeklyVolume(weekly);
      }
    })();
    return () => {
      active = false;
    };
  }, [store, gmail, pending]);

  return (
    <section className="space-y-4" aria-label="Review">
      <p className="text-sm text-muted">
        {pending.length} change{pending.length === 1 ? "" : "s"}: {trusted} trusted, {blocked}{" "}
        blocked, {deferred} deferred.
      </p>

      {pending.length === 0 ? (
        <div className="space-y-3">
          <p className="text-muted">No pending changes.</p>
          <Button onClick={onDone}>Done</Button>
        </div>
      ) : (
        <>
          <ul>
            {pending.map((entry) => (
              <DecisionRow
                key={entry.subjectId}
                pending={entry}
                onChangeDecision={(decision) => onChangeDecision(entry.subjectId, decision)}
                onRemove={() => onRemove(entry)}
              />
            ))}
          </ul>

          <ImpactPreview impact={impact} weeklyVolume={weeklyVolume} />

          <div className="flex flex-wrap gap-2">
            <Button onClick={onApply}>Apply changes</Button>
            <Button variant="ghost" onClick={onBack}>
              Back to triage
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

interface ExecutionPhaseProps {
  store: Store;
  gmail: GmailClient;
  pending: PendingDecision[];
  onReload: () => void;
  onDone: () => void;
}

function ExecutionPhase({ store, gmail, pending, onReload, onDone }: ExecutionPhaseProps) {
  const [results, setResults] = useState<ExecResult[]>([]);
  const [finished, setFinished] = useState(false);
  const [enforcement, setEnforcement] = useState<EnforceResult | null>(null);
  const [enforceError, setEnforceError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const collected: ExecResult[] = [];
      for (const entry of pending) {
        try {
          await applyDecision(store, {
            subjectId: entry.subjectId,
            scope: entry.scope,
            decision: entry.decision,
            actions: entry.actions,
            now: Date.now(),
          });
          collected.push({ label: entry.label, status: "applied" });
        } catch {
          collected.push({ label: entry.label, status: "failed" });
        }
        setResults([...collected]);
      }
      // Record done first, then enforce against Gmail (filters + message actions).
      try {
        setEnforcement(await enforce(gmail, store, { now: Date.now() }));
      } catch (caught) {
        setEnforceError(caught instanceof Error ? caught.message : String(caught));
      }
      setFinished(true);
      onReload();
    })();
  }, [store, gmail, pending, onReload]);

  const applied = results.filter((r) => r.status === "applied").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return (
    <section className="space-y-4" aria-label="Execution">
      <ProgressBar value={results.length} max={pending.length} label="Applying changes" />
      <p aria-live="polite" className="text-sm text-muted">
        {finished
          ? `Done — ${applied} applied${failed > 0 ? `, ${failed} failed` : ""}.`
          : `Applying ${results.length} of ${pending.length}…`}
      </p>

      {finished && (
        <>
          {enforcement !== null && <EnforcementSummary result={enforcement} />}
          {enforceError !== null && (
            <p role="alert" className="text-sm text-block">
              Gmail enforcement failed: {enforceError}
            </p>
          )}
          <p className="text-xs text-muted">
            Decisions are stored on-device; Gmail filters keep enforcing while the app is closed.
            Change any decision later in the <strong>Decisions</strong> tab.
          </p>
          <Button onClick={onDone}>Done</Button>
        </>
      )}
    </section>
  );
}

/** The Gmail enforcement result summary shown after Execution. */
function EnforcementSummary({ result }: { result: EnforceResult }) {
  const lines: string[] = [];
  if (result.filtersCreated > 0) lines.push(`${result.filtersCreated} filter(s) created`);
  if (result.filtersDeleted > 0) lines.push(`${result.filtersDeleted} filter(s) removed`);
  if (result.messagesArchived > 0) lines.push(`${result.messagesArchived} archived`);
  if (result.messagesTrashed > 0) lines.push(`${result.messagesTrashed} trashed`);
  if (result.messagesRescued > 0) lines.push(`${result.messagesRescued} rescued from spam`);
  if (result.unsubscribeRequested > 0) {
    lines.push(`${result.unsubscribeRequested} unsubscribe(s) requested`);
  }

  return (
    <div className="space-y-1 rounded-md border border-line p-3 text-sm" aria-label="Enforcement">
      <p className="font-medium text-ink">Gmail enforcement</p>
      {lines.length > 0 ? (
        <p className="text-muted">{lines.join(" · ")}.</p>
      ) : (
        <p className="text-muted">No Gmail changes were needed.</p>
      )}
      {result.capReached && (
        <p className="text-defer">
          Filter limit reached — {result.skippedAtCap} block(s) not yet filtered.
        </p>
      )}
      {result.failures.length > 0 && (
        <p className="text-block">{result.failures.length} action(s) failed; will retry on sync.</p>
      )}
    </div>
  );
}
