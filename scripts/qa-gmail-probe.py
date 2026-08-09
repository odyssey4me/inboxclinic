#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# Gmail behaviour probe (manual QA against a real account)
# -----------------------------------------------------------------------------
# The fourth, manual, non-gating test tier — see docs/design-testing.md
# (Decision 9: Real-account probes for undocumented provider behaviour), which
# owns this tool's design criteria: read-only wherever the question allows,
# least-privilege short-lived credentials, metadata-only reads, never
# destructive, subjects discovered rather than hard-coded, and evidence over
# verdicts.
#
# It answers what Google does not document and no emulator reproduces, and what
# mocking the GmailClient port can therefore only encode as a belief:
#
#   discover  Samples the mailbox and reports domains that ACTUALLY have mail
#             from both themselves and their subdomains, busiest first, plus
#             example addresses — so the probes below run against real subjects
#             that will send again soon.                         [read-only]
#   search    Does `from:*@domain` behave as a wildcard, and does it span
#             SUBDOMAINS? Prints the sender domains a domain query really
#             returns, and checks a `-from:(a OR b)` exclusion excludes.
#                                                                [read-only]
#   filters   Reads existing filters and checks every stored
#             `criteria.negatedQuery` still parses as `from:(...)` — the shape
#             `unwrapExcludeFrom` needs and the reconcile signature depends on.
#             With --json, dumps them in the port's NativeFilter shape so the
#             real rule set can be replayed through the compiler and the
#             consolidation/adoption suggesters offline.         [read-only]
#   limit     Where does Gmail actually reject an over-long filter?
#             Binary-searches the criteria budget DEFAULT_MAX_CRITERIA_CHARS
#             guesses at. Nothing existing answers this, so it creates and
#             immediately deletes probe filters against an unroutable domain —
#             the only probe needing write scope. It asks for that scope when
#             run, so nothing has to be requested up front.
#                                              [gmail.settings.basic, --i-know]
#
# The semantics under test, and why enforcement depends on them, are in
# docs/design-gmail-integration.md (Decision 5).
#
# Auth: consent grants EXACTLY the scopes the probes you actually run need. The
# read-only ones need nothing more; `limit` asks to widen when you run it, so
# there is no scope flag to know about in advance. Obtained via
# the standard installed-app loopback flow (PKCE) against a project-owned
# Desktop OAuth client. The Google CLI cannot do this — `gcloud auth
# application-default login` refuses to mint a credential without
# `cloud-platform` even when given `--client-id-file`, and `gcloud auth login`
# has no scope flag at all; either would hand a mailbox probe broad Google Cloud
# access. Only the ACCESS token is cached (.local/qa-token.json, 0600,
# gitignored) — never a refresh token — so the credential expires rather than
# persisting, and re-consent per session is the accepted cost.
#
# One-time setup, in the Cloud project that already hosts the app's OAuth client:
#   Credentials -> Create credentials -> OAuth client ID -> Desktop app
#   Download the JSON to .local/oauth-client.json
#
# Replaying a dump through the real code:
#   ./scripts/qa-gmail-probe.py filters --json --out .local/filters.json
#   INBOXCLINIC_FILTER_FIXTURE=$PWD/.local/filters.json npx vitest run realFilters
# (dumps carry your own sender addresses — .local/ is gitignored, keep them there)
#
# Usage:
#   ./scripts/qa-gmail-probe.py login [--client-id-file F]   # optional; probes prompt
#   ./scripts/qa-gmail-probe.py discover [--sample 200]
#   ./scripts/qa-gmail-probe.py search [--domain x.com] [--exclude a@x.com]
#   ./scripts/qa-gmail-probe.py filters [--json] [--out FILE]
#   ./scripts/qa-gmail-probe.py limit --i-know [--domain probe.invalid]
#   ./scripts/qa-gmail-probe.py match arm|check|disarm [--top 3] [--domain x.com]
#   ./scripts/qa-gmail-probe.py revoke
# -----------------------------------------------------------------------------
from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

SCOPE_READ = "https://www.googleapis.com/auth/gmail.readonly"
SCOPE_FILTERS = "https://www.googleapis.com/auth/gmail.settings.basic"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
REVOKE_URI = "https://oauth2.googleapis.com/revoke"

TOKEN_CACHE = ".local/qa-token.json"
CLIENT_FILE = ".local/oauth-client.json"
MATCH_STATE = ".local/qa-match.json"

# Probe filters are built against an unroutable domain (RFC 2606), so one can
# never match, label, or trash a real message even in the instant it exists.
PROBE_DOMAIN = "probe.invalid"

# The `match` probe's action. STARRED is a system label, so it needs no label
# creation (and so no extra scope), it is plainly visible in the UI, and it is
# undone by unstarring — the only action that answers "did this filter match?"
# without moving or hiding a single real message.
MATCH_LABEL = "STARRED"


def fail(message: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def note(message: str) -> None:
    print(f"  {message}")


# --- auth --------------------------------------------------------------------


def read_client(path: str) -> tuple[str, str]:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        fail(
            f"no OAuth client file at {path}.\n\n"
            "       Create one once, in the Cloud project that already hosts the app's client:\n"
            "         Credentials -> Create credentials -> OAuth client ID -> Desktop app\n"
            f"       Download the JSON to {CLIENT_FILE} (gitignored), then re-run login."
        )
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read OAuth client file {path}: {error}")
    section = data.get("installed")
    if section is None:
        fail(
            f"{path} is not a Desktop ('installed') OAuth client — a Web client "
            "cannot use the loopback redirect this flow needs"
        )
    return section["client_id"], section.get("client_secret", "")


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
        fail(f"{url} returned {error.code}: {error.read().decode('utf-8', 'replace')}")
    except urllib.error.URLError as error:
        fail(f"cannot reach {url}: {error}")


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    """Captures the single redirect Google makes back to the loopback address."""

    result: dict[str, str] = {}

    def do_GET(self) -> None:  # noqa: N802 - http.server's required spelling
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        _CallbackHandler.result = {k: v[0] for k, v in query.items()}
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


def cache_write(payload: dict[str, object]) -> None:
    os.makedirs(os.path.dirname(TOKEN_CACHE) or ".", exist_ok=True)
    # 0600: it holds a live bearer token until it expires.
    handle = os.open(TOKEN_CACHE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        json.dump(payload, file)


def cache_read() -> dict[str, object] | None:
    try:
        with open(TOKEN_CACHE, encoding="utf-8") as handle:
            cache = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    # Within a minute of expiry counts as dead: a probe starting now would fail
    # part-way through, which is worse than refusing to start.
    if int(cache.get("expires_at", 0)) - int(time.time()) <= 60:
        return None
    return cache


def cache_clear() -> None:
    cache = None
    try:
        with open(TOKEN_CACHE, encoding="utf-8") as handle:
            cache = json.load(handle)
    except (OSError, json.JSONDecodeError):
        pass
    if cache and cache.get("access_token"):
        # Revoke quietly, without the shared helper's report-and-exit: a token that has
        # simply expired is NOT revocable, and an hour-old credential hitting its designed
        # end should not be announced as an API failure ahead of the real message.
        request = urllib.request.Request(
            REVOKE_URI,
            data=urllib.parse.urlencode({"token": str(cache["access_token"])}).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            urllib.request.urlopen(request, timeout=15).close()
        except (urllib.error.HTTPError, urllib.error.URLError):
            pass  # already expired or revoked upstream; clearing the cache is the point
    try:
        os.remove(TOKEN_CACHE)
    except FileNotFoundError:
        pass


def ensure_token(needed: str) -> str:
    """Return a live token carrying `needed`, consenting on the spot if it doesn't.

    The scope a probe needs is known when it runs, so asking for it then — rather than
    making the caller predict it at login — keeps the credential to what the session has
    actually used, with no flag to remember.
    """
    cache = cache_read()
    if cache is not None and needed in str(cache.get("scope", "")).split():
        left = int(cache["expires_at"]) - int(time.time())  # type: ignore[arg-type]
        if left < 300:
            note(f"note: this credential expires in {left}s; re-run if a probe fails part-way")
        return str(cache["access_token"])

    if cache is None:
        cache_clear()  # a dead credential is cleared, not left to fail again
        reason = "No usable credential."
        scopes = [SCOPE_READ] if needed == SCOPE_READ else [SCOPE_READ, needed]
    else:
        # Widening: keep what the session already has and add what this probe needs, so a
        # read-only credential isn't silently downgraded mid-run.
        reason = f"This probe needs {needed}, which the current credential lacks."
        scopes = sorted({*str(cache.get("scope", "")).split(), needed})

    if not sys.stdin.isatty():
        fail(f"{reason} Run: ./scripts/qa-gmail-probe.py login")
    print(f"{reason}")
    print("Consent to:")
    for scope in scopes:
        print(f"  {scope}")
    if input("Open the browser to authorise? [y/N] ").strip().lower() not in {"y", "yes"}:
        fail("declined — nothing was requested")
    run_consent(scopes, CLIENT_FILE)
    cache = cache_read()
    if cache is None:
        fail("consent completed but no usable token was cached")
    return str(cache["access_token"])


def cmd_login(args: argparse.Namespace) -> None:
    run_consent([SCOPE_READ], args.client_id_file)


def run_consent(scopes: list[str], client_id_file: str) -> None:
    """The installed-app loopback flow (PKCE) for exactly `scopes`."""
    client_id, client_secret = read_client(client_id_file)

    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    state = secrets.token_urlsafe(24)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = int(probe.getsockname()[1])
    redirect_uri = f"http://localhost:{port}"

    url = f"{AUTH_URI}?" + urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(scopes),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
            # No refresh token: this credential is meant to expire.
            "access_type": "online",
            "prompt": "consent",
        }
    )

    server = http.server.HTTPServer(("127.0.0.1", port), _CallbackHandler)
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
    result = _CallbackHandler.result
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
    expires_in = int(token.get("expires_in", 0))  # type: ignore[arg-type]
    cache_write(
        {
            "access_token": token["access_token"],
            "expires_at": int(time.time()) + expires_in,
            "scope": token.get("scope", " ".join(scopes)),
        }
    )
    print(f"\nAuthorised for ~{expires_in // 60} minutes; token cached in {TOKEN_CACHE} (0600).")
    print("No refresh token was requested, so it simply expires.")
    print("Revoke sooner with:  ./scripts/qa-gmail-probe.py revoke")


def cmd_revoke(_args: argparse.Namespace) -> None:
    cache_clear()
    print("Token revoked and cache removed. Also review https://myaccount.google.com/permissions")


# --- api ---------------------------------------------------------------------


def api_get(token: str, path: str, params: dict[str, str] | None = None) -> dict[str, object]:
    url = f"{GMAIL_API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        if error.code == 403:
            fail(f"refused with the current scope: {detail}")
        fail(f"GET {path} returned {error.code}: {detail}")
    except urllib.error.URLError as error:
        fail(f"cannot reach the Gmail API: {error}")


def sender_samples(token: str, query: str, limit: int) -> list[tuple[str, int]]:
    """(sender address, arrival epoch ms) for a query — metadata only, never bodies."""
    listing = api_get(token, "/messages", {"q": query, "maxResults": str(limit)})
    messages = listing.get("messages") or []
    found: list[tuple[str, int]] = []
    for message in messages:  # type: ignore[union-attr]
        meta = api_get(
            token,
            f"/messages/{message['id']}",  # type: ignore[index]
            {"format": "metadata", "metadataHeaders": "From"},
        )
        headers = (meta.get("payload") or {}).get("headers") or []  # type: ignore[union-attr]
        received = int(str(meta.get("internalDate", "0")) or 0)
        for header in headers:
            if str(header.get("name", "")).lower() != "from":
                continue
            value = str(header.get("value", ""))
            match = re.search(r"<([^>]+)>", value)
            address = (match.group(1) if match else value).strip().lower()
            if "@" in address:
                found.append((address, received))
    return found


def sender_addresses(token: str, query: str, limit: int) -> list[str]:
    """Sender addresses for a query — metadata only, never bodies or snippets."""
    return [address for address, _ in sender_samples(token, query, limit)]


def host_of(address: str) -> str:
    return address.rsplit("@", 1)[-1]


# --- probes ------------------------------------------------------------------


def find_pairs(
    token: str, sample: int
) -> tuple[list[tuple[str, list[str], str, int, int]], Counter]:
    """Domains with mail from BOTH themselves and a subdomain, **most recently active first**.

    Parent/child is decided by label-boundary suffix matching between hosts we actually
    observed — no public-suffix list needed, and nothing hard-coded: `notx.com` never counts
    as under `x.com`.

    Ranked by how OFTEN the subtree sends, not by how many subdomains it has or how recently
    it wrote. The `match` probe can only conclude from mail arriving after it is armed, so the
    useful subject is the one that will send repeatedly and soon: a busy domain answers in
    days and keeps confirming, while a structurally richer one that writes once a quarter
    leaves the experiment hanging.

    Structure comes from the sample; **volume is then measured directly**, one query per
    candidate. Counting within the sample would rank on "share of the last N messages", which
    scores a steady sender zero merely for sitting outside the window — a proxy where a real
    number is one call away.
    """
    samples = sender_samples(token, "newer_than:180d", sample)
    example: dict[str, str] = {}
    addresses_per_host: Counter = Counter()
    for address, _received in samples:
        host = host_of(address)
        if address in example:
            continue
        addresses_per_host[host] += 1
        example.setdefault(host, address)

    pairs: list[tuple[str, list[str], str, int, int]] = []
    for parent in sorted(addresses_per_host):
        subs = sorted(h for h in addresses_per_host if h != parent and h.endswith(f".{parent}"))
        if subs:
            # `from:*@parent` spans the subtree (that is the behaviour under test), so one
            # query measures apex and subdomains together — which is the volume that matters.
            volume = recent_volume(token, parent)
            pairs.append((parent, subs, example[subs[0]], addresses_per_host[parent], volume))
    pairs.sort(key=lambda item: item[4], reverse=True)
    return pairs, addresses_per_host


# Ceiling on the per-domain volume count. A real count up to here; at the cap the true
# figure is only known to be "at least this", which is honest enough to rank on.
VOLUME_CAP = 200


def recent_volume(token: str, domain: str, days: int = 30) -> int:
    """Messages from a domain's subtree in the last `days` — counted, capped at VOLUME_CAP.

    Counts returned ids rather than reading `resultSizeEstimate`, which is documented as an
    estimate and measurably is one: on a real account it returned 201 for three unrelated
    domains at 30 and 14 days, then 201 for two of them and 0 for the third at 7 days. A
    number that cannot order three domains, and contradicts itself between windows, is worse
    than no number — ranking on it would be ranking on noise while looking precise.
    """
    listing = api_get(
        token,
        "/messages",
        {"q": f"from:*@{domain} newer_than:{days}d", "maxResults": str(VOLUME_CAP)},
    )
    return len(listing.get("messages") or [])  # type: ignore[arg-type]


def cmd_discover(args: argparse.Namespace) -> None:
    token = ensure_token(SCOPE_READ)
    print(f"== sampling up to {args.sample} recent messages (metadata only) ==\n")
    pairs, counts = find_pairs(token, args.sample)

    print("-- domains with mail from BOTH themselves and a subdomain (busiest first)")
    if not pairs:
        note("none in this sample — try a larger --sample")
    for parent, subs, sub_example, apex, volume in pairs:
        note(f"{parent}  ({volume} messages in the last 30d, {apex} apex sender(s))")
        note(f"  subdomains seen: {', '.join(subs)}")
        note(
            f"  probe it:  ./scripts/qa-gmail-probe.py search --domain {parent}"
            f" --exclude {sub_example}"
        )

    print("\n-- domains with the most distinct sender addresses (exclusion subjects)")
    for host, count in counts.most_common(5):
        note(f"{host}  ({count} distinct address(es))")


def cmd_search(args: argparse.Namespace) -> None:
    token = ensure_token(SCOPE_READ)
    domain, exclude = args.domain, args.exclude

    # No subject given? Find one in the mailbox rather than making the caller
    # guess, or worse, baking a domain into the tool.
    if domain is None:
        print("== no --domain given; discovering a subject from the mailbox ==")
        pairs, _ = find_pairs(token, args.sample)
        if not pairs:
            fail(
                f"no domain with observed subdomain senders in the last {args.sample} messages\n"
                "       pass --domain explicitly, or raise --sample"
            )
        domain, _subs, auto_exclude, _apex, _volume = pairs[0]
        exclude = exclude or auto_exclude
        note(f"chose {domain} (excluding {exclude})\n")

    print(f"== search semantics for {domain} ==\n")
    print(f"-- from:*@{domain} — is `*@` a wildcard, and does it span subdomains?")
    hits = Counter(host_of(a) for a in sender_addresses(token, f"from:*@{domain}", args.sample))
    if not hits:
        note("NO RESULTS — either no such mail, or `*@` is not treated as a wildcard.")
        note("Check by hand before concluding: a literal `*` returns zero, like an empty mailbox.")
    else:
        for host, count in hits.most_common():
            if host == domain:
                note(f"{count}x {host}   (the domain itself)")
            else:
                note(f"{count}x {host}   << SUBDOMAIN/OTHER — matched by a query for {domain}")
        if any(host != domain for host in hits):
            print()
            note("SUBDOMAIN lines mean a domain block sweeps senders the user never decided on.")

    if exclude:
        print(f"\n-- from:*@{domain} -from:({exclude}) — does the parenthesised exclusion apply?")
        excluded_host = host_of(exclude)
        after = Counter(
            host_of(a)
            for a in sender_addresses(token, f"from:*@{domain} -from:({exclude})", args.sample)
        )
        before_count, after_count = hits[excluded_host], after[excluded_host]
        note(f"messages from {excluded_host}: {before_count} without the exclusion, "
             f"{after_count} with it")
        if before_count == 0:
            note("INCONCLUSIVE — nothing to exclude; pick an address you do receive mail from.")
        elif after_count == 0:
            note("PASS — the exclusion removed them.")
        else:
            note("FAIL — the exclusion did NOT remove them.")


# The criteria fields `FilterSpec` represents; anything else makes a filter foreign to the
# code being replayed. Mirrors MODELLED_CRITERIA in the browser adapter.
MODELLED_CRITERIA = {"from", "negatedQuery"}


def constrains_matching(value: object) -> bool:
    """Whether a criteria field actually narrows matching — an echoed default does not."""
    if value is None or value is False or value == "":
        return False
    return not (isinstance(value, list) and not value)


def unwrap_exclude_from(negated: str) -> str | None:
    """`from:(a OR b)` -> `a OR b`, mirroring the browser client's read-back."""
    match = re.fullmatch(r"from:\((.*)\)", negated, re.DOTALL)
    return match.group(1) if match else (negated or None)


def cmd_filters(args: argparse.Namespace) -> None:
    token = ensure_token(SCOPE_READ)
    listing = api_get(token, "/settings/filters")
    filters = listing.get("filter") or []

    if args.json:
        # The port's NativeFilter shape, so a dump replays through the real
        # compiler and suggesters unchanged.
        dump = []
        for f in filters:  # type: ignore[union-attr]
            criteria = f.get("criteria") or {}
            action = f.get("action") or {}
            entry: dict[str, object] = {
                "id": f.get("id"),
                "from": criteria.get("from", ""),
                "addLabelIds": action.get("addLabelIds", []),
                "removeLabelIds": action.get("removeLabelIds", []),
            }
            # `excludeFrom` is OPTIONAL on the port, and the browser client omits the
            # key rather than setting it null. A dump that emits null is not a
            # NativeFilter, and code written against the real shape rightly breaks on
            # it — so omit it here too, or the replay tests a fiction.
            exclude = unwrap_exclude_from(str(criteria.get("negatedQuery", "")))
            if exclude is not None:
                entry["excludeFrom"] = exclude
            # Mirror the adapter: name the criteria the port cannot represent, since the code
            # under replay refuses to reason about a filter carrying any. Omitting this would
            # feed the suggesters filters that look plainly comparable when production would
            # have set them aside — testing a rule the app no longer follows.
            unmodelled = sorted(
                field
                for field, value in criteria.items()
                if field not in MODELLED_CRITERIA and constrains_matching(value)
            )
            if unmodelled:
                entry["unmodelledCriteria"] = unmodelled
            dump.append(entry)
        # Ship the RAW filter beside our projection. The projection is lossy by
        # design — the port models `from`/`negatedQuery` and nothing else — so a
        # dump of only the projection hides exactly the gaps a replay is meant to
        # expose: two filters differing solely in criteria we drop look identical,
        # and the harness cannot tell. Keeping both lets it compare the two.
        payload = {
            "filters": dump,
            "raw": [
                {"id": f.get("id"), "criteria": f.get("criteria") or {}, "action": f.get("action") or {}}
                for f in filters  # type: ignore[union-attr]
            ],
        }
        text = json.dumps(payload, indent=2)
        if args.out:
            os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
            note(f"wrote {len(dump)} filter(s) to {args.out}")
            note(f"replay: INBOXCLINIC_FILTER_FIXTURE=$PWD/{args.out} npx vitest run realFilters")
        else:
            print(text)
        return

    print("== stored filter criteria (read-only) ==")
    with_negated = 0
    for f in filters:  # type: ignore[union-attr]
        criteria = f.get("criteria") or {}
        negated = str(criteria.get("negatedQuery", ""))
        note(str(f.get("id")))
        note(f"  from:         {criteria.get('from', '-')}")
        note(f"  negatedQuery: {negated or '-'}")
        if negated:
            with_negated += 1
            # `unwrapExcludeFrom` parses exactly this shape; anything else means
            # the reconcile signature can't reproduce `excludeFrom`, and filters
            # churn on every sync.
            if re.fullmatch(r"from:\(.*\)", negated, re.DOTALL):
                note("  shape:        OK — matches ^from:\\((.*)\\)$")
            else:
                note("  shape:        MISMATCH — unwrapExcludeFrom would not recover excludeFrom")

    print()
    if with_negated == 0:
        note("No filter carries a negatedQuery, so round-trip fidelity is untested here.")
        note("Create one, then re-run — or use a filter the app itself made.")
    else:
        note(f"{with_negated} filter(s) with a negatedQuery inspected.")
        note("Compare each against what was SENT: it must match byte-for-byte, including")
        note("term order and the spacing around OR.")


def cmd_limit(args: argparse.Namespace) -> None:
    if not args.i_know:
        fail(
            "limit creates and deletes probe filters — pass --i-know to confirm.\n"
            "       The other probes are read-only; this one cannot be."
        )
    token = ensure_token(SCOPE_FILTERS)
    domain = args.domain or PROBE_DOMAIN
    if not domain.endswith(".invalid"):
        note(f"WARNING: {domain} can receive mail; probe filters will briefly exist against it.")

    print(f"== criteria length limit on {domain} (DEFAULT_MAX_CRITERIA_CHARS assumes 1500) ==")
    last_error = ""

    def accepts(target: int) -> bool:
        nonlocal last_error
        sender_from = f"*@{domain}"
        addresses: list[str] = []
        index = 0
        while len(sender_from) + 7 + len(" OR ".join(addresses)) < target and index < 4000:
            addresses.append(f"p{index:04d}@{domain}")
            index += 1
        body = json.dumps(
            {
                "criteria": {
                    "from": sender_from,
                    "negatedQuery": f"from:({' OR '.join(addresses)})",
                },
                "action": {"addLabelIds": ["STARRED"]},
            }
        ).encode()
        request = urllib.request.Request(
            f"{GMAIL_API}/settings/filters",
            data=body,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )

        created_id: str | None = None
        try:
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    created_id = str(json.load(response)["id"])
            except urllib.error.HTTPError as error:
                last_error = error.read().decode("utf-8", "replace")[:200]
                return False
            except urllib.error.URLError as error:
                fail(f"cannot reach the Gmail API: {error}")
            return True
        finally:
            # A probe filter must not outlive its own check — including when the run is
            # interrupted. Without this, Ctrl-C between create and delete strands a filter
            # silently, and the binary search opens that window a dozen-plus times per run.
            if created_id is not None:
                delete = urllib.request.Request(
                    f"{GMAIL_API}/settings/filters/{created_id}",
                    headers={"Authorization": f"Bearer {token}"},
                    method="DELETE",
                )
                try:
                    urllib.request.urlopen(delete, timeout=30).close()
                except Exception:  # noqa: BLE001 - report ANY failure to clean up
                    # Loud and specific: an orphan the user doesn't know about is the one
                    # outcome this probe promises never to leave behind.
                    print(
                        f"WARNING: could not delete probe filter {created_id} — "
                        f"remove it by hand (criteria from:*@{domain})",
                        file=sys.stderr,
                    )

    low = 100
    if not accepts(low):
        fail(f"even {low} chars was rejected: {last_error}")

    # Find a rejection before bisecting: a fixed ceiling that Gmail happens to accept
    # reports the ceiling as "the limit", which is a wrong answer wearing a number.
    high = 0
    probe = low
    while probe <= 60_000:
        probe *= 2
        if accepts(probe):
            low = probe
            note(f"accepted at ~{probe} chars; probing higher")
        else:
            high = probe
            break
    if high == 0:
        note(f"accepted every size up to ~{low} chars without a rejection.")
        note("Either the limit is higher still, or criteria length is not bounded the way")
        note("DEFAULT_MAX_CRITERIA_CHARS assumes. Raise the ceiling in this probe to dig further.")
        return

    last_ok, first_fail = low, high
    while first_fail - last_ok > 25:
        mid = (last_ok + first_fail) // 2
        if accepts(mid):
            last_ok = mid
        else:
            first_fail = mid

    note(f"largest accepted criteria: ~{last_ok} chars")
    note(f"smallest rejected:         ~{first_fail} chars ({last_error})")
    print()
    note(f"DEFAULT_MAX_CRITERIA_CHARS assumes 1500.")
    note("Below that => the budget is too generous and over-long filters still get rejected.")
    note("Above it   => domains degrade to enumerate form earlier than they need to.")

def cmd_match(args: argparse.Namespace) -> None:
    """Arm / check / disarm the live-matching experiment.

    The only two questions left about filter behaviour are about **arriving** mail, which no
    amount of reading the account can answer: does a `*@domain` filter reach the domain's
    SUBDOMAINS, and does its `negatedQuery` actually spare the excepted sender?

    Several subjects are armed at once, not one. Each needs mail to arrive before it can say
    anything, so a single subject that goes quiet stalls the experiment — and independent
    domains agreeing is far better evidence than one domain answering, while domains
    DISAGREEING is itself a finding worth having.
    """
    if args.action == "check":
        state = _load_match_state()
        if state is None:
            fail("nothing armed — run: ./scripts/qa-gmail-probe.py match arm")
        token = ensure_token(SCOPE_READ)
        _match_report(token, state)
        return

    if args.action == "disarm":
        state = _load_match_state()
        if state is None:
            note("nothing armed")
            return
        token = ensure_token(SCOPE_FILTERS)
        armed_at = int(state["armedAt"])  # type: ignore[arg-type]
        subjects: list[dict[str, str]] = state["subjects"]  # type: ignore[assignment]
        for subject in subjects:
            _delete_filter(token, str(subject["filterId"]))
            note(f"removed the probe filter for {subject['domain']}")
        os.remove(MATCH_STATE)

        # Deleting a filter does not undo what it already did, and this probe deliberately
        # holds no scope to modify mail — unstarring would need `gmail.modify`, the same
        # permission the app uses to trash and archive, which is far more than a QA tool
        # should carry to tidy up after itself. Hand over the exact searches instead: each
        # selects only this probe's work, so it is select-all then unstar, per subject.
        stamp = time.strftime("%Y/%m/%d", time.gmtime(armed_at))
        domains = " OR ".join(f"*@{subject['domain']}" for subject in subjects)
        print()
        note("The stars it added are still there. Paste this into Gmail search,")
        note("then select all and unstar:")
        note(f"  is:starred after:{stamp} from:({domains})")
        note("(dated from the arming day, so it can also catch mail you starred yourself")
        note(" from those domains since then — worth a glance before unstarring.)")
        return

    # arm
    if _load_match_state() is not None:
        fail(
            "already armed — disarm first, or the old filters keep starring mail:\n"
            "       ./scripts/qa-gmail-probe.py match disarm"
        )
    token = ensure_token(SCOPE_FILTERS)

    subjects: list[dict[str, str]] = []
    if args.domain:
        exclude = args.exclude or _pick_exclusion(token, args.domain)
        subjects.append({"domain": args.domain, "exclude": exclude})
    else:
        # Busiest first: a subject that sends often answers soonest and keeps confirming.
        print(f"== choosing the {args.top} busiest subjects in the mailbox ==")
        pairs, addresses_per_host = find_pairs(token, args.sample)
        if not pairs:
            fail(
                f"no domain with observed subdomain senders in the last {args.sample} messages\n"
                "       pass --domain explicitly, or raise --sample"
            )
        for domain, subs, _example, _apex, volume in pairs[: args.top]:
            exclude = _pick_exclusion(token, domain)
            if exclude is None:
                note(f"skipping {domain} — no apex sender to except, so nothing to prove")
                continue
            note(f"{domain} ({volume} msgs/30d; subdomains: {', '.join(subs)})")
            subjects.append({"domain": domain, "exclude": exclude})

        # The two questions have DIFFERENT eligibility. Only a domain with subdomain senders
        # can answer the subdomain question, so the subjects above are chosen for it — but
        # the exclusion question needs no subdomains at all, just two senders at one domain.
        # Left as-is, that half waits on whether the apex senders above happen to write, and
        # apex addresses at these domains are often the quiet ones. Add the busiest
        # multi-sender domain outright so it can answer on its own schedule.
        chosen = {subject["domain"] for subject in subjects}
        candidates = sorted(
            (host for host, count in addresses_per_host.items() if count >= 2 and host not in chosen),
            key=lambda host: recent_volume(token, host),
            reverse=True,
        )
        for host in candidates[:1]:
            exclude = _pick_exclusion(token, host)
            if exclude is None:
                continue
            note(f"{host} — added for the exclusion question alone (no subdomains needed)")
            subjects.append({"domain": host, "exclude": exclude})

    if not subjects:
        fail("no usable subject found")

    armed_at = int(time.time())
    for subject in subjects:
        subject["filterId"] = _create_match_filter(token, subject["domain"], subject["exclude"])
    with open(MATCH_STATE, "w", encoding="utf-8") as handle:
        # Only mail arriving after this point is evidence; anything older predates the filters.
        json.dump({"armedAt": armed_at, "subjects": subjects}, handle)

    print()
    for subject in subjects:
        note(f"armed: from:*@{subject['domain']} except {subject['exclude']} → adds {MATCH_LABEL}")
    note("They star matching mail and nothing else — no message is moved, hidden or deleted.")
    note("Wait for mail from those domains, then:")
    note("  ./scripts/qa-gmail-probe.py match check")
    note("  ./scripts/qa-gmail-probe.py match disarm     # when done (then unstar)")


def _load_match_state() -> dict[str, object] | None:
    """The armed state, normalised — tolerating a single-subject file from an earlier arm."""
    try:
        with open(MATCH_STATE, encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    if "subjects" not in state and "filterId" in state:
        state = {
            "armedAt": state["armedAt"],
            "subjects": [
                {
                    "filterId": state["filterId"],
                    "domain": state["domain"],
                    "exclude": state["exclude"],
                }
            ],
        }
    return state


def _pick_exclusion(token: str, domain: str) -> str | None:
    """An apex address that genuinely sends — an exclusion nothing matches proves nothing."""
    addresses = sorted(set(sender_addresses(token, f"from:*@{domain}", 60)))
    apex = [a for a in addresses if host_of(a) == domain]
    return apex[0] if apex else None


def _create_match_filter(token: str, domain: str, exclude: str) -> str:
    body = json.dumps(
        {
            "criteria": {"from": f"*@{domain}", "negatedQuery": f"from:({exclude})"},
            "action": {"addLabelIds": [MATCH_LABEL]},
        }
    ).encode()
    request = urllib.request.Request(
        f"{GMAIL_API}/settings/filters",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return str(json.load(response)["id"])
    except urllib.error.HTTPError as error:
        fail(f"could not create the probe filter for {domain}: "
             f"{error.read().decode('utf-8', 'replace')}")


def _delete_filter(token: str, filter_id: str) -> None:
    request = urllib.request.Request(
        f"{GMAIL_API}/settings/filters/{filter_id}",
        headers={"Authorization": f"Bearer {token}"},
        method="DELETE",
    )
    try:
        urllib.request.urlopen(request, timeout=30).close()
    except urllib.error.HTTPError as error:
        if error.code != 404:
            note(f"WARNING: could not delete filter {filter_id} — remove it by hand")
    except urllib.error.URLError:
        note(f"WARNING: could not delete filter {filter_id} — remove it by hand")


def _subject_counts(token: str, subject: dict[str, str], armed_at: int) -> tuple[int, int, int, int, int, int]:
    """(apex starred, apex total, sub starred, sub total, excluded starred, excluded total)."""
    domain, exclude = subject["domain"], subject["exclude"]
    # `after:` takes seconds; only mail that arrived since arming can be evidence.
    listing = api_get(
        token, "/messages", {"q": f"from:*@{domain} after:{armed_at}", "maxResults": "50"}
    )
    apex_starred = apex_total = sub_starred = sub_total = excluded_starred = excluded_total = 0
    for message in listing.get("messages") or []:  # type: ignore[union-attr]
        meta = api_get(
            token,
            f"/messages/{message['id']}",  # type: ignore[index]
            {"format": "metadata", "metadataHeaders": "From"},
        )
        headers = (meta.get("payload") or {}).get("headers") or []  # type: ignore[union-attr]
        raw = next(
            (str(h.get("value", "")) for h in headers if str(h.get("name", "")).lower() == "from"),
            "",
        )
        match = re.search(r"<([^>]+)>", raw)
        address = (match.group(1) if match else raw).strip().lower()
        starred = MATCH_LABEL in (meta.get("labelIds") or [])  # type: ignore[operator]

        if address == exclude:
            excluded_total += 1
            excluded_starred += int(starred)
        elif host_of(address) == domain:
            apex_total += 1
            apex_starred += int(starred)
        else:
            sub_total += 1
            sub_starred += int(starred)
    return apex_starred, apex_total, sub_starred, sub_total, excluded_starred, excluded_total


def _match_report(token: str, state: dict[str, object]) -> None:
    armed_at = int(state["armedAt"])  # type: ignore[arg-type]
    subjects: list[dict[str, str]] = state["subjects"]  # type: ignore[assignment]
    print(f"== live filter matching ({int(time.time()) - armed_at}s since arming) ==")

    spans: list[bool] = []
    spares: list[bool] = []
    for subject in subjects:
        counts = _subject_counts(token, subject, armed_at)
        apex_s, apex_t, sub_s, sub_t, exc_s, exc_t = counts
        print()
        note(f"{subject['domain']} (excepting {subject['exclude']})")
        note(f"  apex:      {apex_s}/{apex_t} starred")
        note(f"  subdomain: {sub_s}/{sub_t} starred")
        note(f"  excepted:  {exc_s}/{exc_t} starred")
        if sub_t == 0:
            note("  subdomains: no evidence yet")
        elif sub_s == sub_t:
            spans.append(True)
            note("  subdomains: REACHED by the filter")
        elif sub_s == 0:
            spans.append(False)
            note("  subdomains: NOT reached")
        else:
            note("  subdomains: mixed — record which senders matched; not a clean answer")
        if exc_t == 0:
            note("  exception:  no evidence yet")
        else:
            spares.append(exc_s == 0)
            note("  exception:  " + ("SPARED" if exc_s == 0 else "NOT spared"))

    print()
    if not spans:
        note("SUBDOMAINS: still inconclusive — no subdomain mail has arrived for any subject.")
    elif all(spans):
        note(f"SUBDOMAINS: reached, consistently across {len(spans)} subject(s). A domain block")
        note("            enforces over the whole subtree going forward.")
    elif not any(spans):
        note(f"SUBDOMAINS: NOT reached, across {len(spans)} subject(s) — while search does reach")
        note("            them. The sweep over-reaches while future subdomain mail is unblocked.")
    else:
        note("SUBDOMAINS: subjects DISAGREE — matching is not uniform, which is itself the")
        note("            finding. Record which domains did what before concluding anything.")

    if not spares:
        note("EXCEPTION:  still inconclusive — no excepted sender has written since arming.")
    elif all(spares):
        note("EXCEPTION:  negatedQuery spares the excepted sender's arriving mail.")
    else:
        note("EXCEPTION:  negatedQuery did NOT spare it somewhere — a domain block would trash a")
        note("            sender the user explicitly trusted. A correctness bug, not a caveat.")


# --- cli ---------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Gmail behaviour probe — see docs/design-testing.md Decision 9.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    login = sub.add_parser("login", help="consent up front (read-only; probes widen on demand)")
    login.add_argument("--client-id-file", default=CLIENT_FILE)
    login.set_defaults(func=cmd_login)

    sub.add_parser("revoke", help="revoke the token and delete its cache").set_defaults(
        func=cmd_revoke
    )

    discover = sub.add_parser("discover", help="find real probe subjects in the mailbox")
    discover.add_argument("--sample", type=int, default=200)
    discover.set_defaults(func=cmd_discover)

    search = sub.add_parser("search", help="wildcard / subdomain / exclusion semantics")
    search.add_argument("--domain", help="omit to discover one from the mailbox")
    search.add_argument("--exclude")
    search.add_argument("--sample", type=int, default=200)
    search.set_defaults(func=cmd_search)

    filters = sub.add_parser("filters", help="stored negatedQuery shape; --json to dump")
    filters.add_argument("--json", action="store_true")
    filters.add_argument("--out")
    filters.set_defaults(func=cmd_filters)

    limit = sub.add_parser("limit", help="find the real criteria length limit (writes!)")
    limit.add_argument("--i-know", action="store_true")
    limit.add_argument("--domain")
    limit.set_defaults(func=cmd_limit)

    match = sub.add_parser("match", help="live filter matching: subdomains + exclusion (writes!)")
    match.add_argument("action", choices=["arm", "check", "disarm"])
    match.add_argument("--domain", help="a domain you actually receive mail from")
    match.add_argument("--exclude", help="address to except; discovered from the mailbox if omitted")
    match.add_argument("--sample", type=int, default=200)
    match.add_argument("--top", type=int, default=3, help="how many subjects to arm at once")
    match.set_defaults(func=cmd_match)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
