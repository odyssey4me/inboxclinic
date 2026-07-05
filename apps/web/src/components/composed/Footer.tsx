// SPDX-License-Identifier: Apache-2.0
const REPO_URL = "https://github.com/odyssey4me/inboxclinic";
const SPONSOR_URL = "https://github.com/sponsors/odyssey4me";

/**
 * App footer: open-source + funding links (design-deployment.md — Sponsors link in the
 * app footer). No tracking, no billing code — just outbound links to the public repo and
 * the GitHub Sponsors page.
 */
export function Footer() {
  return (
    <footer className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-6 text-center text-xs text-muted">
      <span>Inbox Clinic — open-source, local-first. Apache-2.0.</span>
      <a href={REPO_URL} className="underline hover:text-ink">
        Source
      </a>
      <a href={SPONSOR_URL} className="underline hover:text-ink">
        Sponsor
      </a>
    </footer>
  );
}
