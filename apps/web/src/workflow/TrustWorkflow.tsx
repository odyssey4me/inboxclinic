import {
  applyDecision,
  keyFor,
  type BlockAction,
  type Decision,
  type DecisionScope,
  type Sender,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { BatchOffer } from "../components/composed/BatchOffer";
import { DecisionRow } from "../components/composed/DecisionRow";
import { PromptCard } from "../components/composed/PromptCard";
import { TrustActions } from "../components/composed/TrustActions";
import { Button } from "../components/ui/Button";
import { ProgressBar } from "../components/ui/ProgressBar";
import { useStoreSnapshot } from "../hooks/useStoreSnapshot";
import type { PendingDecision } from "./pendingDecisions";

type Phase = "discovery" | "decision" | "review" | "execution";

const PHASE_LABELS: { id: Phase; label: string }[] = [
  { id: "discovery", label: "Discovery" },
  { id: "decision", label: "Decision" },
  { id: "review", label: "Review" },
  { id: "execution", label: "Execution" },
];

interface ExecResult {
  label: string;
  status: "applied" | "failed";
}

export interface TrustWorkflowProps {
  store: Store;
  onDone: () => void;
}

/** The four-phase trust-decision workflow (Discovery → Decision → Review → Execution). */
export function TrustWorkflow({ store, onDone }: TrustWorkflowProps) {
  const { data, reload } = useStoreSnapshot(store);

  const [queue, setQueue] = useState<Sender[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<PendingDecision[]>([]);
  const [phase, setPhase] = useState<Phase>("discovery");
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
    return <p className="p-6 text-center text-slate-500">Loading…</p>;
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
      setPhase("discovery");
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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-5 px-4 py-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Trust decisions</h1>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </header>

      <ol className="flex items-center gap-2 text-xs" aria-label="Workflow progress">
        {PHASE_LABELS.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.id === phase ? "step" : undefined}
            className={step.id === phase ? "font-semibold text-slate-900" : "text-slate-400"}
          >
            {index + 1}. {step.label}
          </li>
        ))}
      </ol>

      {phase === "discovery" && current !== undefined && (
        <section className="space-y-4" aria-label="Discovery">
          <PromptCard sender={current} />
          <BatchOffer
            domain={current.domain}
            batchSize={domainSize.get(current.domain) ?? 1}
            onReviewAsGroup={() => {
              setScope("domain");
              setPhase("decision");
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setPhase("decision")}>Make a decision</Button>
            <Button variant="ghost" onClick={skip}>
              Skip for now
            </Button>
            {pending.length > 0 && (
              <Button variant="secondary" onClick={() => setPhase("review")}>
                Review {pending.length} change{pending.length === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        </section>
      )}

      {phase === "decision" && current !== undefined && (
        <section className="space-y-4" aria-label="Decision">
          <PromptCard sender={current} />
          <TrustActions
            sender={current}
            scope={scope}
            onScopeChange={setScope}
            canScopeDomain={(domainSize.get(current.domain) ?? 1) >= 2}
            onDecide={decide}
          />
          <Button variant="ghost" onClick={() => setPhase("discovery")}>
            Back
          </Button>
        </section>
      )}

      {phase === "review" && (
        <ReviewPhase
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
              setPhase("discovery");
            }
          }}
          onDone={onDone}
        />
      )}

      {phase === "execution" && (
        <ExecutionPhase store={store} pending={pending} onReload={reload} onDone={onDone} />
      )}
    </main>
  );
}

interface ReviewPhaseProps {
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
  return (
    <section className="space-y-4" aria-label="Review">
      <p className="text-sm text-slate-600">
        {pending.length} change{pending.length === 1 ? "" : "s"}: {trusted} trusted, {blocked}{" "}
        blocked, {deferred} deferred.
      </p>

      {pending.length === 0 ? (
        <div className="space-y-3">
          <p className="text-slate-500">No pending changes.</p>
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
  pending: PendingDecision[];
  onReload: () => void;
  onDone: () => void;
}

function ExecutionPhase({ store, pending, onReload, onDone }: ExecutionPhaseProps) {
  const [results, setResults] = useState<ExecResult[]>([]);
  const [finished, setFinished] = useState(false);
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
      setFinished(true);
      onReload();
    })();
  }, [store, pending, onReload]);

  const applied = results.filter((r) => r.status === "applied").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return (
    <section className="space-y-4" aria-label="Execution">
      <ProgressBar value={results.length} max={pending.length} label="Applying changes" />
      <p aria-live="polite" className="text-sm text-slate-600">
        {finished
          ? `Done — ${applied} applied${failed > 0 ? `, ${failed} failed` : ""}.`
          : `Applying ${results.length} of ${pending.length}…`}
      </p>

      {finished && (
        <>
          <p className="text-xs text-slate-400">
            Persisted locally. Undo in Settings → Past decisions. Gmail enforcement runs later.
          </p>
          <Button onClick={onDone}>Done</Button>
        </>
      )}
    </section>
  );
}
