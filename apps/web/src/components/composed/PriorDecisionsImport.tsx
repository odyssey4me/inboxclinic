// SPDX-License-Identifier: Apache-2.0
import {
  enforce,
  importLearnedDecisions,
  learnPriorDecisions,
  type GmailClient,
  type LearnedSuggestion,
  type LearnReason,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useState } from "react";

import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

export interface PriorDecisionsImportProps {
  store: Store;
  gmail: GmailClient;
  online: boolean;
  /** Called after prior decisions are imported so the caller can refresh its view. */
  onImported: () => void;
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
 * "Found prior decisions" card: on open it learns the "no" decisions already implied by
 * existing Gmail filters + Spam/Trash (read-only), and offers to import them as Blocked so
 * they're recorded here too (design-trust-decisions.md). Self-contained — it owns the
 * learn/import lifecycle and only tells the parent when something was imported.
 */
export function PriorDecisionsImport({
  store,
  gmail,
  online,
  onImported,
}: PriorDecisionsImportProps) {
  const [suggestions, setSuggestions] = useState<LearnedSuggestion[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      onImported();
      setNote(`Imported ${count} prior decision${count === 1 ? "" : "s"} as blocked.`);
      setSuggestions([]);
    } catch (caught) {
      setError(`Import failed: ${errorMessage(caught)}`);
    } finally {
      setImporting(false);
    }
  };

  if (note !== null) {
    return (
      <p role="status" className="text-sm text-accent-ink">
        {note}
      </p>
    );
  }

  if (suggestions.length === 0 || dismissed) return null;

  return (
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
          <li key={`${s.scope}:${s.subjectId}`} className="flex items-center justify-between gap-2">
            <span className="truncate text-ink">{s.label}</span>
            <span className="shrink-0 text-xs text-muted">{REASON_TEXT[s.reason]}</span>
          </li>
        ))}
      </ul>
      {error !== null && (
        <p role="alert" className="text-sm text-block">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={() => void importAll()} disabled={importing || !online}>
          {importing ? "Importing…" : "Import all as Blocked"}
        </Button>
        <Button variant="ghost" onClick={() => setDismissed(true)} disabled={importing}>
          Dismiss
        </Button>
      </div>
    </Card>
  );
}
