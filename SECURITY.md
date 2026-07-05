# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

Use GitHub's **[private vulnerability reporting](https://github.com/odyssey4me/inboxclinic/security/advisories/new)**
(repo → **Security** → **Report a vulnerability**). We aim to acknowledge reports within a
few days and will coordinate a fix and disclosure with you.

## Scope

Inbox Clinic is a **client-only, local-first** browser PWA with **no backend**. By
construction:

- It **stores no secrets** — the OAuth client id is public (PKCE), and no client secret or
  refresh token is ever stored (architecture.md §5–6).
- It reads Gmail **metadata only** (never message bodies) and keeps all user data
  **on-device**.
- All hosting is static (Cloudflare Pages); there is no server that could hold credentials.

The most valuable reports concern: the browser OAuth/token handling, the on-device store,
the native-Gmail-filter compilation, the Drive backup/restore path, or the build/deploy
supply chain (dependencies, CI).

## Supported versions

The project is in **Alpha**; only the latest `main` is supported. Fixes land on `main`.

## Handling

Dependencies are monitored by Dependabot (alerts + security updates), code is scanned with
CodeQL, and pull requests run dependency review — see the workflows in `.github/workflows/`.
