# Inbox Clinic

**Privacy-first Gmail inbox management that runs entirely in your browser.**

Inbox Clinic helps you regain control of your inbox — it analyses your email patterns,
surfaces the senders that matter, and turns your trust decisions into native Gmail
filters that Google enforces for you. It runs as a **local-first web app**: your data
and your Google credentials never leave your device, and there are no servers.

## Status

**Alpha — in active development (rebuild in progress).** Access is invite-only via a
Google test-user allowlist; self-hosting is supported.

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

## Repository structure (target)

```
inboxclinic/
├── apps/web/        # the PWA (React + Vite + Tailwind)
├── packages/core/   # framework-agnostic logic (provider client, scoring, store, filters)
└── docs/            # architecture, design docs, roadmap
```
> The repository is being rebuilt to this shape — see [docs/ROADMAP.md](docs/ROADMAP.md).

## Support the project

Inbox Clinic is free and open-source. If it helps you, you can support its running costs
via **GitHub Sponsors**.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and guidelines.

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE).

---

*For support, please [open an issue](https://github.com/odyssey4me/inboxclinic/issues).*
