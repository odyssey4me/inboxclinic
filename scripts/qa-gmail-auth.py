#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# Least-privilege OAuth for the Gmail behaviour probe
# -----------------------------------------------------------------------------
# Runs the standard installed-app loopback flow (PKCE) against a project-owned
# Desktop OAuth client, so consent grants EXACTLY the Gmail scopes a probe needs.
#
# Why this exists rather than the Google CLI: `gcloud auth application-default
# login` refuses to mint a credential without `cloud-platform` — even when given
# `--client-id-file` — and `gcloud auth login` has no scope flag at all. Either
# route would hand a mailbox probe broad Google Cloud access to the account,
# which is the opposite of the criterion this tier is built on.
#
# Only the ACCESS token is cached (`.local/qa-token.json`, gitignored), never the
# refresh token: the credential dies with its ~1h lifetime instead of persisting
# on disk, which bounds what a leaked cache file is worth.
#
# See docs/design-testing.md (Decision 9) for the design criteria this serves;
# scripts/qa-gmail-probe.sh is the only intended caller.
#
# Usage (via the probe script):
#   qa-gmail-auth.py login  <client-file> <cache-file> <scope> [<scope> ...]
#   qa-gmail-auth.py token  <cache-file>      # prints a live token, else exits 1
#   qa-gmail-auth.py status <cache-file>      # "<seconds-left> <scopes>" or "dead"
#   qa-gmail-auth.py revoke <cache-file>      # revoke upstream + delete cache
# -----------------------------------------------------------------------------
from __future__ import annotations

import base64
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
REVOKE_URI = "https://oauth2.googleapis.com/revoke"


def fail(message: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_client(path: str) -> tuple[str, str]:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read OAuth client file {path}: {error}")
    section = data.get("installed")
    if section is None:
        fail(
            f"{path} is not a Desktop ('installed') OAuth client — "
            "a Web client cannot use the loopback redirect this flow needs"
        )
    return section["client_id"], section.get("client_secret", "")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    """Captures the single redirect Google makes back to the loopback address."""

    result: dict[str, str] = {}

    def do_GET(self) -> None:  # noqa: N802 - http.server's required spelling
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        CallbackHandler.result = {k: v[0] for k, v in query.items()}
        body = (
            b"<html><body style='font-family:system-ui;padding:2rem'>"
            b"<h3>Authorisation received</h3><p>You can close this tab and return "
            b"to the terminal.</p></body></html>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        """Silence the default stderr access log."""


def post_form(url: str, fields: dict[str, str]) -> dict[str, object]:
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(fields).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        fail(f"token endpoint returned {error.code}: {detail}")
    except urllib.error.URLError as error:
        fail(f"cannot reach the token endpoint: {error}")


def write_cache(path: str, payload: dict[str, object]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    # Written 0600: it holds a live bearer token until it expires.
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        json.dump(payload, file)


def load_cache(path: str) -> dict[str, object] | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


def cmd_login(client_file: str, cache_file: str, scopes: list[str]) -> None:
    client_id, client_secret = read_client(client_file)
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    state = secrets.token_urlsafe(24)
    port = free_port()
    redirect_uri = f"http://localhost:{port}"

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        # No refresh token is requested: this credential is meant to expire.
        "access_type": "online",
        "prompt": "consent",
    }
    url = f"{AUTH_URI}?{urllib.parse.urlencode(params)}"

    server = http.server.HTTPServer(("127.0.0.1", port), CallbackHandler)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()

    print("Requesting only:")
    for scope in scopes:
        print(f"  {scope}")
    print("\nOpen this URL to consent (it should open automatically):\n")
    print(url + "\n")
    if os.system(f'xdg-open "{url}" >/dev/null 2>&1') != 0:  # noqa: S605
        print("(could not open a browser automatically — paste the URL above)")

    thread.join(timeout=300)
    server.server_close()
    result = CallbackHandler.result
    if not result:
        fail("timed out waiting for the browser redirect")
    if result.get("state") != state:
        fail("state mismatch on the redirect — aborting rather than trusting it")
    if "error" in result:
        fail(f"consent was declined or failed: {result['error']}")

    token = post_form(
        TOKEN_URI,
        {
            "code": result["code"],
            "client_id": client_id,
            "client_secret": client_secret,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        },
    )
    expires_in = int(token.get("expires_in", 0))
    write_cache(
        cache_file,
        {
            "access_token": token["access_token"],
            "expires_at": int(time.time()) + expires_in,
            "scope": token.get("scope", " ".join(scopes)),
        },
    )
    print(f"Authorised for ~{expires_in // 60} minutes. Token cached in {cache_file} (0600).")
    print("No refresh token was requested, so it simply expires.")


def live_cache(cache_file: str) -> dict[str, object] | None:
    cache = load_cache(cache_file)
    if cache is None:
        return None
    # A token within a minute of expiry is treated as dead: a probe that starts
    # now would fail part-way through, which is worse than refusing to start.
    if int(cache.get("expires_at", 0)) - int(time.time()) <= 60:
        return None
    return cache


def cmd_token(cache_file: str) -> None:
    cache = live_cache(cache_file)
    if cache is None:
        raise SystemExit(1)
    print(cache["access_token"])


def cmd_status(cache_file: str) -> None:
    cache = live_cache(cache_file)
    if cache is None:
        print("dead")
        return
    left = int(cache["expires_at"]) - int(time.time())  # type: ignore[arg-type]
    print(f"{left} {cache.get('scope', '')}")


def cmd_revoke(cache_file: str) -> None:
    cache = load_cache(cache_file)
    if cache is not None and cache.get("access_token"):
        try:
            post_form(REVOKE_URI, {"token": str(cache["access_token"])})
        except SystemExit:
            # Already expired or revoked upstream — deleting the cache is what matters.
            pass
    try:
        os.remove(cache_file)
    except FileNotFoundError:
        pass


def main(argv: list[str]) -> None:
    if len(argv) < 3:
        fail("usage: qa-gmail-auth.py <login|token|status|revoke> ...")
    command = argv[1]
    if command == "login":
        if len(argv) < 5:
            fail("usage: qa-gmail-auth.py login <client-file> <cache-file> <scope>...")
        cmd_login(argv[2], argv[3], argv[4:])
    elif command == "token":
        cmd_token(argv[2])
    elif command == "status":
        cmd_status(argv[2])
    elif command == "revoke":
        cmd_revoke(argv[2])
    else:
        fail(f"unknown command: {command}")


if __name__ == "__main__":
    main(sys.argv)
