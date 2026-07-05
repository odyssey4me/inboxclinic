# Inbox Clinic

[![CI](https://github.com/odyssey4me/inboxclinic/actions/workflows/ci.yml/badge.svg)](https://github.com/odyssey4me/inboxclinic/actions/workflows/ci.yml)
[![CodeQL](https://github.com/odyssey4me/inboxclinic/actions/workflows/codeql.yml/badge.svg)](https://github.com/odyssey4me/inboxclinic/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/odyssey4me/inboxclinic/badge)](https://securityscorecards.dev/viewer/?uri=github.com/odyssey4me/inboxclinic)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Live](https://img.shields.io/badge/live-inboxclinic.com-brightgreen)](https://inboxclinic.com)

**Privacy-first Gmail inbox management that runs entirely in your browser.**

Inbox Clinic helps you regain control of your inbox — it analyses your email patterns,
surfaces the senders that matter, and turns your trust decisions into native Gmail
filters that Google enforces for you. It runs as a **local-first web app**: your data
and your Google credentials never leave your device, and there are no servers.

## Status

**Alpha — v1 feature-complete; open-source and self-hostable.** Access to the hosted
instance is invite-only via a Google test-user allowlist; self-hosting is supported.

## What it does

- **Sender & domain analysis** — extracts and categorises who emails you (metadata only).
- **Trust decisions** — trust, block, or defer each sender or domain, prioritised by impact.
- **Native Gmail enforcement** — decisions compile into Gmail's own filters, so triage
  keeps working even when the app is closed.
- **Local-first** — all data lives on your device; works offline; installable as a PWA.
- **Optional Google Drive backup** — back up and restore your decisions to your own Drive.
- **Privacy by construction** — we never read your email content, never store your
  credentials, and run no servers or databases.

## How it works

The app runs in your browser and talks **directly to Gmail**. It reads message
*metadata* (never bodies), works out your senders, and helps you decide which to trust
or block. Decisions are recorded on your device and compiled into **native Gmail
filters** that Google applies continuously. Nothing is sent to us — there is no backend.

See **[docs/architecture.md](docs/architecture.md)** for the full design and
**[docs/](docs/README.md)** for the documentation index.

## Privacy

- **Metadata only** — email bodies are never read or stored.
- **No credential custody** — short-lived access tokens live in memory only; no refresh
  token or client secret is stored.
- **On-device** — your data stays in your browser; export or delete it at any time.

## Getting access

Inbox Clinic runs in Google "testing" mode with a small allowlist. **Request access**
from within the app and you'll be added — or **self-host** your own instance against
your own Google OAuth client (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Technology

A static **TypeScript** Progressive Web App (React + Vite) over framework-agnostic core
logic. No backend, no database, no infrastructure beyond static hosting. Details are in
the design docs ([docs/](docs/README.md)).

## Repository structure

```
inboxclinic/
├── apps/web/        # the PWA (React + Vite + Tailwind)
├── packages/core/   # framework-agnostic logic (provider client, scoring, store, filters)
├── packages/store/  # Dexie (IndexedDB) adapter for the core store port
└── docs/            # architecture, design docs, roadmap
```

## Deploy & self-host

The app is static files with **no secrets** — anyone can build and host their own.

**Deploy to Cloudflare Pages (the hosted setup):**

1. Create a **Cloudflare Pages** project connected to your fork (Workers & Pages → Create
   → Pages → Connect to Git).
2. Build settings — build command `npm run build`, output directory `apps/web/dist`, root
   directory `/`.
3. Add env var **`VITE_OAUTH_CLIENT_ID`** (your public Google OAuth client id) and,
   optionally, `VITE_REQUEST_ACCESS_URL`. These are **public**, not secrets.
4. Add your **custom domain** in the Pages project; Cloudflare provisions TLS and DNS.

`apps/web/public/_redirects` (SPA fallback) and `_headers` (security headers) are applied
automatically. GitHub Actions (`ci.yml`) still runs the tests/build/zero-secrets gate.

**Self-host anywhere:** build with `VITE_OAUTH_CLIENT_ID=<your client id> npm run build`
and serve `apps/web/dist/` on any static host (default base `/`; set `BASE_PATH=/sub/` only
if serving under a sub-path). Use your **own** Google OAuth client (add yourself as the
only test user) — see [CONTRIBUTING.md](CONTRIBUTING.md) for the build-time variables.

> **Access:** the hosted instance runs in Google "testing" mode with a maintainer
> allowlist — see the [access runbook](docs/runbook-access.md). Self-hosters are their own
> allowlist.

## Support the project

Inbox Clinic is free and open-source. If it helps you, you can support its running costs
via **GitHub Sponsors**.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and guidelines.

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE).

---

*For support, please [open an issue](https://github.com/odyssey4me/inboxclinic/issues).*
