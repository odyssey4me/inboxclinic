// SPDX-License-Identifier: Apache-2.0
const REPO_URL = "https://github.com/odyssey4me/inboxclinic";
const SPONSOR_URL = "https://github.com/sponsors/odyssey4me";

/** Deployed build stamp (design-error-reporting.md): short commit SHA + build date. */
const COMMIT = __APP_COMMIT__;
const BUILT_AT = __APP_BUILT_AT__;
/** A real SHA links to its commit; a local/test build ("dev"/"test") is shown as plain text. */
const IS_RELEASE = COMMIT !== "dev" && COMMIT !== "test";

/** ISO date → `YYYY-MM-DD`, or "" if unparseable. */
function buildDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : "";
}

/**
 * App footer: open-source + funding links (design-deployment.md — Sponsors link in the
 * app footer) plus the deployed build stamp so a user (and any diagnostic report) can say
 * exactly what was live. No tracking, no billing code — just outbound links.
 */
export function Footer() {
  const date = buildDate(BUILT_AT);
  const version = `${COMMIT}${date !== "" ? ` · ${date}` : ""}`;
  return (
    <footer className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-6 text-center text-xs text-muted">
      <span>Inbox Clinic — open-source, local-first. Apache-2.0.</span>
      <a href={REPO_URL} className="underline hover:text-ink">
        Source
      </a>
      <a href={SPONSOR_URL} className="underline hover:text-ink">
        Sponsor
      </a>
      {IS_RELEASE ? (
        <a
          href={`${REPO_URL}/commit/${COMMIT}`}
          className="font-mono underline hover:text-ink"
          title={`Build ${COMMIT} — ${BUILT_AT}`}
        >
          {version}
        </a>
      ) : (
        <span className="font-mono">{version}</span>
      )}
    </footer>
  );
}
