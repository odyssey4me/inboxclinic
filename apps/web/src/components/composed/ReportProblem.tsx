// SPDX-License-Identifier: Apache-2.0
import {
  getInstallId,
  redact,
  type DiagnosticReport,
  type ReportingClient,
  type Store,
} from "@inboxclinic/core";
import { useEffect, useMemo, useState } from "react";

import { reportMarkdown } from "../../reporting/report";
import { Button } from "../ui/Button";

export interface ReportProblemProps {
  store: Store;
  /** Pre-fill from a captured error (message/stack/view). */
  initial?: { message?: string; stack?: string; view?: string };
  /** When set (with a token source), a Submit action is offered; else copy/download only. */
  client?: ReportingClient;
  /** Obtain an anti-abuse (Turnstile) token — required to Submit. */
  getHumanToken?: () => Promise<string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Trigger a client-side download of `text` as a markdown file. */
function downloadMarkdown(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "inbox-clinic-report.md";
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * The opt-in "Report a problem" panel (design-error-reporting.md Decisions 1, 3, 4). Builds a
 * **redacted** report, shows the **exact** payload the user can edit, and offers Copy /
 * Download (no backend) plus Submit when a reporting client + Turnstile token are available.
 * An anonymous install ID is sent as a separate field, never shown in the published body.
 */
export function ReportProblem({ store, initial, client, getHumanToken }: ReportProblemProps) {
  const [summary, setSummary] = useState(() => redact(initial?.message));
  const [note, setNote] = useState("");
  const [installId, setInstallId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getInstallId(store).then((id) => {
      if (active) setInstallId(id);
    });
    return () => {
      active = false;
    };
  }, [store]);

  const stack = useMemo(() => redact(initial?.stack), [initial?.stack]);

  const report = useMemo<DiagnosticReport>(() => {
    const base: DiagnosticReport = {
      message: summary,
      appVersion: __APP_COMMIT__,
      builtAt: __APP_BUILT_AT__,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      installId: installId ?? "",
    };
    if (stack !== "") base.stack = stack;
    if (initial?.view !== undefined && initial.view !== "") base.view = initial.view;
    if (note.trim() !== "") base.note = note;
    return base;
  }, [summary, stack, initial?.view, note, installId]);

  const preview = useMemo(() => reportMarkdown(report), [report]);
  const canSubmit = client !== undefined && getHumanToken !== undefined;

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(preview);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const submit = async (): Promise<void> => {
    if (client === undefined || getHumanToken === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getHumanToken();
      const { ref } = await client.submit(report, token);
      setResult(ref === "" ? "Sent — thank you." : ref);
    } catch (caught) {
      setError(`Could not send: ${errorMessage(caught)}. You can still copy or download it.`);
    } finally {
      setBusy(false);
    }
  };

  if (result !== null) {
    return (
      <div className="space-y-2" role="status">
        <p className="text-sm font-medium text-ink">Thanks — your report was sent.</p>
        {result.startsWith("http") ? (
          <a
            href={result}
            className="text-sm text-accent-ink underline"
            target="_blank"
            rel="noreferrer"
          >
            View it
          </a>
        ) : (
          <p className="text-sm text-muted">{result}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="text-sm font-medium text-ink">Summary</span>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          placeholder="What happened?"
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-ink">Anything to add? (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </label>

      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Exactly what will be sent
        </p>
        <pre className="max-h-56 overflow-auto rounded-md border border-line bg-surface-2 p-3 text-xs text-ink whitespace-pre-wrap">
          {preview}
        </pre>
        <p className="text-xs text-muted">
          Plus an anonymous ID{installId !== null ? ` (${installId.slice(0, 8)}…)` : ""} sent
          privately for abuse-prevention — never shown in the report.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="secondary" onClick={() => downloadMarkdown(preview)}>
          Download
        </Button>
        {canSubmit && (
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Sending…" : "Send report"}
          </Button>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-block">
          {error}
        </p>
      )}
    </div>
  );
}
