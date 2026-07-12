// SPDX-License-Identifier: Apache-2.0
import {
  applyDecision,
  defaultBlockActions,
  enforce,
  importLearnedDecisions,
  learnPriorDecisions,
  simulateEnforcement,
  type BlockAction,
  type Decision,
  type DecisionScope,
  type GmailClient,
  type LearnedSuggestion,
  type LearnReason,
  type SimulatedImpact,
  type Store,
  type TrustStatus,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

import { ImpactPreview } from "../components/composed/ImpactPreview";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { useStoreSnapshot } from "../hooks/useStoreSnapshot";

export interface DecisionsProps {
  store: Store;
  gmail: GmailClient;
  online: boolean;
  /** Called after a decision change so the app can refresh other views. */
  onChanged: () => void;
}

/** A subject that already carries a trust/block decision. */
interface DecidedSubject {
  subjectId: string;
  scope: DecisionScope;
  label: string;
  status: Extract<TrustStatus, "trusted" | "blocked">;
  /** Block actions to stage if the subject is (re)blocked. */
  blockActions: BlockAction[];
}

interface PendingChange {
  subject: DecidedSubject;
  to: Extract<Decision, "trust" | "block">;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const REASON_TEXT: Record<LearnReason, string> = {
  filter: "existing filter",
  spam: "marked spam",
  trash: "binned unread",
};

/**
 * Decisions view: every recorded trust/block, revisable at any time. Changing a decision
 * previews its impact (a read-only dry-run), then applies it and reconciles Gmail filters
 * (design-trust-decisions.md Decision 6/7).
 */
export function Decisions({ store, gmail, online, onChanged }: DecisionsProps) {
  const { data, error: loadError, reload } = useStoreSnapshot(store);
  const [query, setQuery] = useState("");
  const [change, setChange] = useState<PendingChange | null>(null);
  const [impact, setImpact] = useState<SimulatedImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<LearnedSuggestion[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [importing, setImporting] = useState(false);

  // On open, learn prior "no" decisions from existing filters + Spam/Trash (read-only).
  useEffect(() => {
    if (!online) return;
    let active = true;
    void (async () => {
      const found = await learnPriorDecisions(gmail, store);
      if (active) setSuggestions(found);
    })();
    return () => {
      active = false;
    };
  }, [store, gmail, online]);

  const importAll = async (): Promise<void> => {
    setImporting(true);
    setError(null);
    try {
      const count = await importLearnedDecisions(store, suggestions, Date.now());
      await enforce(gmail, store);
      await reload();
      onChanged();
      setNote(`Imported ${count} prior decision${count === 1 ? "" : "s"} as blocked.`);
      setSuggestions([]);
    } catch (caught) {
      setError(`Import failed: ${errorMessage(caught)}`);
    } finally {
      setImporting(false);
    }
  };

  const subjects: DecidedSubject[] = [
    ...(data?.senders ?? [])
      .filter(
        (s): s is typeof s & { trustStatus: "trusted" | "blocked" } => s.trustStatus !== "pending",
      )
      .map((s) => ({
        subjectId: s.id,
        scope: "address" as const,
        label: s.email,
        status: s.trustStatus,
        blockActions: defaultBlockActions(s),
      })),
    ...(data?.domains ?? [])
      .filter(
        (d): d is typeof d & { trustStatus: "trusted" | "blocked" } => d.trustStatus !== "pending",
      )
      .map((d) => ({
        subjectId: d.id,
        scope: "domain" as const,
        label: d.domain,
        status: d.trustStatus,
        blockActions: ["create_filter" as const],
      })),
  ];

  const q = query.trim().toLowerCase();
  const filtered = subjects
    .filter((s) => q === "" || s.label.toLowerCase().includes(q) || s.status.includes(q))
    .sort((a, b) => a.label.localeCompare(b.label));

  const openChange = async (subject: DecidedSubject, to: PendingChange["to"]): Promise<void> => {
    setNote(null);
    setError(null);
    setImpact(null);
    setChange({ subject, to });
    const actions = to === "block" ? subject.blockActions : [];
    setImpact(
      await simulateEnforcement(gmail, store, [
        { subjectId: subject.subjectId, scope: subject.scope, decision: to, actions },
      ]),
    );
  };

  const confirmChange = async (): Promise<void> => {
    if (change === null) return;
    setBusy(true);
    setError(null);
    try {
      const actions = change.to === "block" ? change.subject.blockActions : [];
      await applyDecision(store, {
        subjectId: change.subject.subjectId,
        scope: change.subject.scope,
        decision: change.to,
        actions,
        decidedVia: "settings",
        now: Date.now(),
      });
      await enforce(gmail, store);
      await reload();
      onChanged();
      setNote(`${change.subject.label} is now ${change.to === "trust" ? "trusted" : "blocked"}.`);
      setChange(null);
    } catch (caught) {
      setError(`Could not apply the change: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">Decisions</h2>
        <p className="text-sm text-muted">
          Every trust or block you've made — change any of them at any time. A change is previewed
          first, then reconciles your Gmail filters.
        </p>
      </div>

      {loadError !== null && (
        <div role="alert" className="flex items-center justify-between gap-3 text-sm text-block">
          <span>Couldn't load your decisions: {loadError}</span>
          <Button variant="ghost" onClick={reload}>
            Retry
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted">{subjects.length} decided</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search decisions…"
          aria-label="Search decisions"
          className="min-h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-56"
        />
      </div>

      {suggestions.length > 0 && !dismissed && (
        <Card aria-label="Prior decisions found" className="space-y-3 border-accent/40">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold">
              Found {suggestions.length} prior decision{suggestions.length === 1 ? "" : "s"}
            </h3>
            <p className="text-sm text-muted">
              Senders you already filter or bin. Import them as Blocked? Nothing is deleted — Gmail
              already handles them; this just records the decisions here.
            </p>
          </div>
          <ul className="space-y-1 text-sm">
            {suggestions.map((s) => (
              <li
                key={`${s.scope}:${s.subjectId}`}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate text-ink">{s.label}</span>
                <span className="shrink-0 text-xs text-muted">{REASON_TEXT[s.reason]}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button onClick={() => void importAll()} disabled={importing || !online}>
              {importing ? "Importing…" : "Import all as Blocked"}
            </Button>
            <Button variant="ghost" onClick={() => setDismissed(true)} disabled={importing}>
              Dismiss
            </Button>
          </div>
        </Card>
      )}

      {change !== null && (
        <Card
          role="alertdialog"
          aria-label="Confirm decision change"
          className="space-y-4 border-accent/40"
        >
          <div className="space-y-1">
            <h3 className="text-lg font-semibold">Change decision</h3>
            <p className="text-sm text-muted">
              <span className="font-medium text-ink">{change.subject.label}</span> —{" "}
              {change.subject.status} → {change.to === "trust" ? "trusted" : "blocked"}.
            </p>
          </div>
          <ImpactPreview impact={impact} />
          <div className="flex gap-2">
            <Button onClick={() => void confirmChange()} disabled={busy || impact === null}>
              {busy ? "Applying…" : "Confirm & apply"}
            </Button>
            <Button variant="ghost" onClick={() => setChange(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {filtered.length === 0 ? (
        <p className="text-sm text-muted">
          {subjects.length === 0
            ? "No decisions yet — triage some senders from the Dashboard."
            : `No decisions match “${query}”.`}
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((subject) => (
            <li
              key={`${subject.scope}:${subject.subjectId}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{subject.label}</p>
                <p className="text-xs text-muted">
                  {subject.scope === "domain" ? "whole domain" : "this address"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={subject.status === "trusted" ? "green" : "red"}>
                  {subject.status}
                </Badge>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void openChange(subject, subject.status === "blocked" ? "trust" : "block")
                  }
                  disabled={!online || busy}
                >
                  {subject.status === "blocked" ? "Change to Trust" : "Change to Block"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {note !== null && (
        <p role="status" className="text-sm text-accent-ink">
          {note}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-block">
          {error}
        </p>
      )}
    </div>
  );
}
