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
#             immediately deletes probe filters against an unroutable domain.
#                                                            [writes, --i-know]
#   match     Does a live `*@domain` filter reach SUBDOMAINS, and does its
#             `negatedQuery` spare the excepted sender's ARRIVING mail? Neither
#             is answerable by reading the account — only by mail that arrives
#             after a filter exists. Arms filters whose only action is to add
#             STARRED (a system label: no label creation, no extra scope,
#             nothing moved or deleted), then reports what got starred. Subjects
#             are ranked by the rate of the evidence each can actually produce,
#             and the expected wait is stated when arming, so a slow subject is
#             obvious up front rather than after days of silence.
#                                                 [writes, to arm and disarm]
#
# The semantics under test, and why enforcement depends on them, are in
# docs/design-gmail-integration.md (Decision 5).
#
# Auth: one consent per session, covering every scope the probes use — Gmail
# read-only plus filter management. Not progressive: a probe never stops half way
# to ask, and no terminal is needed, since the browser consent screen is what
# actually grants it. This is a hand-run QA tool against the developer's own
# mailbox, so the credential is bounded by its LIFETIME rather than its
# narrowness. Obtained via
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
#   ./scripts/qa-gmail-probe.py login [--client-id-file F]   # optional; one consent
#                                                            #   covers every probe
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
# Every scope any probe uses. `login` requests the lot, so one consent covers a whole
# session — see cmd_login for why that beats widening per probe in practice.
ALL_SCOPES = [SCOPE_READ, SCOPE_FILTERS]
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

# Messages examined per subject when checking. A conclusion drawn from a truncated page
# would read as confidently as one drawn from everything, so the sample size is reported
# alongside each verdict rather than left implicit.
MATCH_PAGE = 100


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
        # An unreadable or corrupt cache is the same situation as no cache at all: there is no
        # token to revoke, and the file is removed below either way. Nothing to report.
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
        # Already gone — this function's job is "no cached credential remains", which is
        # exactly the state a missing file describes. Not an error.
        pass


def ensure_token(needed: str) -> str:
    """Return a live token carrying `needed`, consenting for ALL_SCOPES if none does.

    One grant per session, not progressive: asking per probe stopped runs half way to request
    a scope, and where there is no terminal to ask at, could not request it at all. This is a
    QA tool run by hand against the developer's own mailbox — the credential is bounded by its
    lifetime rather than its narrowness (access token only, about an hour, no refresh token).
    """
    cache = cache_read()
    if cache is not None and needed in str(cache.get("scope", "")).split():
        left = int(cache["expires_at"]) - int(time.time())  # type: ignore[arg-type]
        if left < 300:
            note(f"note: this credential expires in {left}s; re-run if a probe fails part-way")
        return str(cache["access_token"])

    # Dead, or minted before this probe's scope was needed. Either way it is replaced rather
    # than left to fail again on the next call.
    cache_clear()
    print("No usable credential.")
    print("Consent to:")
    for scope in ALL_SCOPES:
        print(f"  {scope}")
    # No terminal to confirm at? Open the browser anyway — Google's consent screen names the
    # same scopes and is what actually grants them.
    if sys.stdin.isatty():
        if input("Open the browser to authorise? [y/N] ").strip().lower() not in {"y", "yes"}:
            fail("declined — nothing was requested")
    else:
        print("(no terminal to confirm at — opening the browser; consent there, or close it)")
    run_consent(ALL_SCOPES, CLIENT_FILE)
    cache = cache_read()
    if cache is None:
        fail("consent completed but no usable token was cached")
    return str(cache["access_token"])


def cmd_login(args: argparse.Namespace) -> None:
    """Consent once, to every scope any probe uses — so no probe stops to ask later."""
    run_consent(ALL_SCOPES, args.client_id_file)


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


# Counting window for how often a subtree's SUBDOMAINS send. Much wider than the 30 days
# once used for general activity, because subdomain mail is RARE: on a real account the
# busiest candidate managed 8 subdomain messages in 90 days, so a 30-day window returned 0
# or 1 for nearly every domain and could not order them at all.
SUBDOMAIN_WINDOW_DAYS = 90

# Ceiling on any counted query. A real count up to here; at the cap the true figure is only
# known to be "at least this", which is honest enough to rank on.
VOLUME_CAP = 200


def weekly(count: int, days: int = SUBDOMAIN_WINDOW_DAYS) -> float:
    """A per-week rate, so a wait can be estimated from it rather than guessed at."""
    return count * 7.0 / days


def count_messages(token: str, query: str, cap: int = VOLUME_CAP) -> int:
    """Messages matching `query` — counted from returned ids, never estimated.

    Counts ids rather than reading `resultSizeEstimate`, which is documented as an estimate
    and measurably is one: on a real account it returned 201 for three unrelated domains at
    30 and 14 days, then 201 for two of them and 0 for the third at 7 days. A number that
    cannot order three domains, and contradicts itself between windows, is worse than no
    number — ranking on it would be ranking on noise while looking precise.
    """
    listing = api_get(token, "/messages", {"q": query, "maxResults": str(cap)})
    return len(listing.get("messages") or [])  # type: ignore[arg-type]


def sub_roots(subs: list[str]) -> list[str]:
    """The topmost observed subdomains — so one query per root counts the subtree once.

    `from:*@x` spans x's own subtree, so counting every observed subdomain separately would
    count a message from `y.x.example.com` twice — once under `x.example.com`, once under
    itself — inflating the very number subjects are ranked on.
    """
    return [s for s in subs if not any(s != other and s.endswith(f".{other}") for other in subs)]


def subdomain_volume(token: str, subs: list[str]) -> tuple[int, dict[str, int]]:
    """(total, per-subdomain) message counts over SUBDOMAIN_WINDOW_DAYS."""
    per_sub = {
        sub: count_messages(token, f"from:*@{sub} newer_than:{SUBDOMAIN_WINDOW_DAYS}d")
        for sub in sub_roots(subs)
    }
    return sum(per_sub.values()), per_sub


def find_pairs(token: str, sample: int) -> tuple[list[dict[str, object]], Counter, Counter]:
    """Domains with mail from BOTH themselves and a subdomain, **best evidence rate first**.

    Parent/child is decided by label-boundary suffix matching between hosts we actually
    observed — no public-suffix list needed, and nothing hard-coded: `notx.com` never counts
    as under `x.com`.

    Ranked by how often the **subdomains** send, because subdomain mail is the only mail that
    can answer the subdomain question. Ranking on *subtree* volume — what this did before —
    ranks overwhelmingly on apex mail, which is the bulk of it: the first live run armed
    `amazon.co.uk` as its "busiest" subject and then waited five days on a subdomain that
    sends about once a quarter, while `monzo.com` and `google.com` — an order of magnitude
    better on the only axis that mattered — went unarmed.

    Structure comes from the sample; the rate is then measured directly, one query per
    subdomain root. Counting within the sample would rank on "share of the last N messages",
    which scores a steady sender zero merely for sitting outside the window — a proxy where a
    real number is one call away.

    Returns (pairs, distinct addresses per host, messages per address). The last is kept
    because the *exception* question is rate-limited by a single ADDRESS, not by a domain.
    """
    # A year, not 180 days: subdomain senders are rare enough that a narrower window omits
    # the structure entirely — the ranking below cannot consider a pair it never saw.
    samples = sender_samples(token, "newer_than:365d", sample)
    example: dict[str, str] = {}
    seen_addresses: set[str] = set()
    addresses_per_host: Counter = Counter()
    messages_per_address: Counter = Counter()
    for address, _received in samples:
        host = host_of(address)
        messages_per_address[address] += 1
        # Count each address ONCE. This previously tested `address in example`, whose keys are
        # hosts — a test no address can pass, since every address contains an `@` and no host
        # does. So the dedupe never fired and this counted MESSAGES while reporting "distinct
        # sender addresses": a real account showed `amazon.co.uk` as 14 apex senders when it
        # has 4. The exclusion-only candidate filter below thresholds on this number.
        if address in seen_addresses:
            continue
        seen_addresses.add(address)
        addresses_per_host[host] += 1
        example.setdefault(host, address)

    pairs: list[dict[str, object]] = []
    for parent in sorted(addresses_per_host):
        subs = sorted(h for h in addresses_per_host if h != parent and h.endswith(f".{parent}"))
        if not subs:
            continue
        volume, per_sub = subdomain_volume(token, subs)
        pairs.append(
            {
                "parent": parent,
                "subs": subs,
                "example": example[subs[0]],
                "apexSenders": addresses_per_host[parent],
                "subVolume": volume,
                "perSub": per_sub,
            }
        )
    # Ties broken by name so a re-run picks the same subjects rather than whichever the API
    # happened to list first.
    pairs.sort(key=lambda pair: (-int(pair["subVolume"]), str(pair["parent"])))  # type: ignore[arg-type]
    return pairs, addresses_per_host, messages_per_address


def cmd_discover(args: argparse.Namespace) -> None:
    token = ensure_token(SCOPE_READ)
    print(f"== sampling up to {args.sample} recent messages (metadata only) ==\n")
    pairs, counts, per_address = find_pairs(token, args.sample)

    print("-- domains with mail from BOTH themselves and a subdomain")
    note(f"(ranked by SUBDOMAIN send rate over {SUBDOMAIN_WINDOW_DAYS}d — the only mail that")
    note(" can answer the subdomain question, and the rate at which `match` can answer it)")
    if not pairs:
        note("none in this sample — try a larger --sample")
    for pair in pairs:
        volume = int(pair["subVolume"])  # type: ignore[arg-type]
        note(
            f"{pair['parent']}  ({volume} subdomain msgs/{SUBDOMAIN_WINDOW_DAYS}d"
            f" = ~{weekly(volume):.1f}/week, {pair['apexSenders']} apex sender(s))"
        )
        for sub, count in sorted(pair["perSub"].items(), key=lambda kv: -kv[1]):  # type: ignore[union-attr]
            note(f"    {sub}  {count}/{SUBDOMAIN_WINDOW_DAYS}d")
        note(
            f"  probe it:  ./scripts/qa-gmail-probe.py search --domain {pair['parent']}"
            f" --exclude {pair['example']}"
        )

    print("\n-- domains with the most distinct sender addresses (exclusion subjects)")
    for host, count in counts.most_common(5):
        busiest = max(
            (n for address, n in per_address.items() if host_of(address) == host), default=0
        )
        note(f"{host}  ({count} distinct address(es); busiest sent {busiest} in the sample)")
    note("The exception question waits on ONE address, so the busiest single sender matters")
    note("more here than the domain's total — see `match arm`.")


def cmd_search(args: argparse.Namespace) -> None:
    token = ensure_token(SCOPE_READ)
    domain, exclude = args.domain, args.exclude

    # No subject given? Find one in the mailbox rather than making the caller
    # guess, or worse, baking a domain into the tool.
    if domain is None:
        print("== no --domain given; discovering a subject from the mailbox ==")
        pairs, _, _ = find_pairs(token, args.sample)
        if not pairs:
            fail(
                f"no domain with observed subdomain senders in the last {args.sample} messages\n"
                "       pass --domain explicitly, or raise --sample"
            )
        domain = str(pairs[0]["parent"])
        exclude = exclude or str(pairs[0]["example"])
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


# --- public-suffix probe (#252) --------------------------------------------------

PSL_CORPUS = ".local/psl.json"


def load_psl(path: str) -> tuple[set[str], set[str], set[str]]:
    """The live list as three rule sets: normal, wildcard bases, exceptions.

    Fetched by ./scripts/fetch-psl-corpus.sh, never committed — it is real-world data about
    real domains, and the same corpus the offline replay spec uses.
    """
    if not os.path.exists(path):
        fail(
            f"no PSL corpus at {path}\n"
            "       fetch it first:  ./scripts/fetch-psl-corpus.sh"
        )
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    normal, wildcard, exception = set(), set(), set()
    for entry in data["rules"]:
        rule, kind = entry["rule"], entry["kind"]
        if kind == "wildcard":
            wildcard.add(rule[2:])
        elif kind == "exception":
            exception.add(rule[1:])
        else:
            normal.add(rule)
    return normal, wildcard, exception


def public_suffix_of(host: str, psl: tuple[set[str], set[str], set[str]]) -> str:
    """The PSL algorithm: exceptions first, then the longest matching rule, else `*`.

    Deliberately implemented here rather than shelling out to the app's `tldts`: this probe
    asks whether GMAIL respects these boundaries, so it must read the boundaries from the
    published list rather than from the same library whose behaviour is under discussion.
    """
    normal, wildcard, exception = psl
    labels = host.strip().lower().rstrip(".").split(".")
    for i in range(len(labels)):
        candidate = ".".join(labels[i:])
        # An exception rule means this name is registrable, so its suffix is one label up.
        if candidate in exception:
            return ".".join(labels[i + 1 :])
        if candidate in normal:
            return candidate
        # `*.ck` makes every `<label>.ck` a suffix.
        if i > 0 and ".".join(labels[i:]) in wildcard:
            return ".".join(labels[i - 1 :])
    return labels[-1]


def registrable_of(host: str, psl: tuple[set[str], set[str], set[str]]) -> str | None:
    """eTLD+1, or None when the host IS a public suffix (nothing to own)."""
    suffix = public_suffix_of(host, psl)
    if host.lower() == suffix:
        return None
    extra = host.lower()[: -(len(suffix) + 1)].split(".")
    return f"{extra[-1]}.{suffix}"


def cmd_psl(args: argparse.Namespace) -> None:
    """Does Gmail's matcher respect Public Suffix List boundaries?

    The app's decision model is PSL-aware on purpose: `allowPrivateDomains: true` makes
    `alice.github.io` and `bob.github.io` different organisations, and Decision 9 names that
    as exactly what a parent-domain rule must never get wrong. Gmail's matcher knows nothing
    about the PSL — it matches labels. If `from:*@github.io` returns both tenants, a rule the
    user pointed at THEIR tenant would reach every other tenant of that suffix.

    Read-only throughout: every question here is answerable by observing search results, so
    no write scope and no armed filters.
    """
    token = ensure_token(SCOPE_READ)
    psl = load_psl(args.corpus)
    normal, wildcard, _ = psl

    # A named subject skips discovery entirely — three queries instead of a sampling pass plus
    # three per subject, and it can be pointed at structure the sample will not surface (a
    # PRIVATE-suffix tenant with siblings, say, which a mailbox may hold none of). Same shape
    # as `search --domain` and `match --domain`: explicit when you know, discovered when you
    # do not, never baked in.
    if args.domain is not None:
        suffix = public_suffix_of(args.domain, psl)
        registrable = registrable_of(args.domain, psl)
        if registrable is None:
            fail(
                f"{args.domain} IS a public suffix ({suffix}) — nothing can be keyed on it,\n"
                "       so there is no rule to test. Give a domain BENEATH a suffix."
            )
        print(f"== {args.domain} — suffix {suffix}, tenant {registrable} ==")
        subjects = [(suffix, [registrable])]
        return probe_subjects(token, args, psl, subjects)

    print(f"== sampling up to {args.sample} recent messages (metadata only) ==\n")
    hosts = Counter(host_of(a) for a in sender_addresses(token, "newer_than:365d", args.sample))

    # Group observed hosts by the suffix the PUBLISHED list says they sit under, keeping only
    # suffixes with two or more distinct registrable domains beneath them: one tenant proves
    # nothing, because a query for the suffix returning it is what a correct matcher does too.
    tenants: dict[str, set[str]] = {}
    for host in hosts:
        suffix = public_suffix_of(host, psl)
        registrable = registrable_of(host, psl)
        if registrable is None:
            continue
        tenants.setdefault(suffix, set()).add(registrable)

    subjects = [
        (suffix, sorted(names))
        for suffix, names in tenants.items()
        if len(names) >= 2 and (suffix in normal or suffix.split(".", 1)[-1] in wildcard)
    ]
    # Ranked by how much evidence each can produce (criterion 6): more distinct tenants under
    # one suffix means a clearer answer, and a multi-label suffix is the sharper test since a
    # single-label TLD reaching across tenants would surprise nobody.
    # Ranked by how much the answer can TELL us, not by how much mail there is. A bare
    # public suffix is unownable by construction — `registrableDomain` returns None for it,
    # so no rule the app compiles can ever be keyed on one — which makes `com` the least
    # informative subject in the mailbox however many tenants sit under it. A PRIVATE-section
    # suffix is the sharpest, since that is the boundary `allowPrivateDomains` exists to hold;
    # a multi-label ICANN suffix next; single-label TLDs last.
    with open(args.corpus, encoding="utf-8") as handle:
        private_bases = {
            r["rule"].lstrip("*.") for r in json.load(handle)["rules"] if r["section"] == "PRIVATE"
        }
    subjects.sort(
        key=lambda s: (s[0] in private_bases, "." in s[0], len(s[1])),
        reverse=True,
    )

    if not subjects:
        note("no suffix in this sample has two or more distinct domains beneath it —")
        note("try a larger --sample; without two tenants the question cannot be answered.")
        return

    print("-- suffixes with two or more distinct registrable domains observed beneath them")
    for suffix, names in subjects[: args.top]:
        kind = "multi-label" if "." in suffix else "single-label"
        note(f"{suffix}  ({kind}; {len(names)} tenants: {', '.join(names[:4])})")

    probe_subjects(token, args, psl, subjects)

def probe_subjects(
    token: str,
    args: argparse.Namespace,
    psl: tuple[set[str], set[str], set[str]],
    subjects: list[tuple[str, list[str]]],
) -> None:
    """Run the three queries per subject and report what each reached.

    Shared by both modes so a named subject and a discovered one are asked exactly the same
    questions — the discovery pass only decides *which* subjects, never how they are judged.
    """
    for suffix, names in subjects[: args.top]:
        print(f"\n== does a query for the SUFFIX {suffix} reach across its tenants? ==")
        by_form: dict[str, Counter] = {}
        for form in (f"from:*@{suffix}", f"from:{suffix}"):
            print(f"\n-- {form}")
            got = Counter(host_of(a) for a in sender_addresses(token, form, args.sample))
            by_form[form] = got
            if not got:
                note("NO RESULTS — nothing matched. A literal `*` returns zero, like an empty")
                note("mailbox, so this is not by itself evidence of a narrow match.")
                continue
            reached = {registrable_of(h, psl) for h in got} - {None}
            for host, count in got.most_common(8):
                note(f"{count}x {host}   (tenant: {registrable_of(host, psl)})")
            if len(reached) > 1:
                note("")
                note(f"reached {len(reached)} distinct tenants — a query for this suffix sweeps")
                note("across the boundary the PSL draws.")
                note("This is SEVERITY, not a defect: the app cannot key a rule on a bare public")
                note(f"suffix ({suffix} has no registrable domain), so no compiled filter looks")
                note("like this. It measures what getting `allowPrivateDomains` wrong would cost.")
            else:
                note("")
                note("One tenant only — consistent with the boundary being respected, though")
                note("not proof: the others may simply have sent nothing in the sample.")

        # `*@X` vs bare `X`. Decision 9 contrasts the two as different forms with different
        # reach, and design-gmail-integration.md Decision 5 point 9 builds the domain-block
        # model on `*@domain` specifically. If they return the same set, `*@` is contributing
        # nothing and both are matching the domain token — which would explain every
        # measurement to date, #210's included, without any wildcard being involved.
        wild, bare = by_form.get(f"from:*@{suffix}"), by_form.get(f"from:{suffix}")
        if wild is not None and bare is not None:
            print(f"\n-- `*@{suffix}` vs bare `{suffix}`")
            if wild == bare:
                note(f"IDENTICAL result sets ({sum(wild.values())} messages, {len(wild)} hosts).")
                note("On this subject `*@` changes nothing — consistent with it being inert")
                note("rather than a wildcard operator.")
            else:
                only_wild = sorted(set(wild) - set(bare))[:5]
                only_bare = sorted(set(bare) - set(wild))[:5]
                note(f"DIFFERENT — only `*@`: {only_wild or 'none'}; only bare: {only_bare or 'none'}")
                note("The two forms are distinct, as Decision 9 assumes.")

        # The question that IS about a rule the app can actually emit. A parent-domain rule is
        # keyed on the REGISTRABLE domain, never on the suffix — so what matters is whether a
        # query for one tenant stays inside that tenant, or leaks to its siblings under the
        # same suffix. A leak here would mean a rule the user aimed at their own domain
        # reaching a stranger's.
        # Siblings from what the SUFFIX queries actually returned, not from the sample: a
        # named subject has no sample, and the query's own results are the better evidence in
        # either case — they are the tenants Gmail itself put under this suffix.
        observed = {registrable_of(h, psl) for got in by_form.values() for h in got} - {None}
        tenant = names[0]
        siblings = (observed | set(names)) - {tenant}
        print(f"\n-- from:{tenant} — does a rule keyed on ONE tenant stay inside it?")
        got = Counter(host_of(a) for a in sender_addresses(token, f"from:{tenant}", args.sample))
        leaked = {registrable_of(h, psl) for h in got} & siblings
        for host, count in got.most_common(6):
            note(f"{count}x {host}   (tenant: {registrable_of(host, psl)})")
        if leaked:
            note("")
            note(f"LEAKED to {len(leaked)} sibling tenant(s): {', '.join(sorted(leaked)[:5])}")
            note("A parent-domain rule would reach domains the user never decided on.")
        elif got:
            note("")
            note(f"Stayed within {tenant} — the rule form the app compiles does not cross")
            note(f"the {suffix} boundary, on this evidence.")
        else:
            note("")
            note("NO RESULTS — inconclusive; nothing matched this form at all.")



# The criteria fields `FilterSpec` represents; anything else makes a filter foreign to the
# code being replayed. Mirrors MODELLED_CRITERIA in the browser adapter.
MODELLED_CRITERIA = {"from", "negatedQuery"}


def constrains_matching(value: object) -> bool:
    """Whether a criteria field actually narrows matching — an echoed default does not."""
    if value is None or value is False or value == "":
        return False
    return not (isinstance(value, list) and not value)


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
            # `excludeFrom` is left for the replay spec to derive, not computed here: it
            # reads `negatedQuery` off `raw` (below) through the real `unwrapExcludeFrom`
            # from `packages/core`, so this dump has no second implementation of that parse
            # left to drift out of step with production (#216).
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
            # The spec needs an absolute path; only a relative --out needs $PWD glued on.
            fixture = args.out if os.path.isabs(args.out) else f"$PWD/{args.out}"
            note(f"replay: INBOXCLINIC_FILTER_FIXTURE={fixture} npx vitest run realFilters")
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
            # "Nothing armed" reads as "nothing to clean up", which is only true if the state
            # file was never lost. A probe filter outlives its record — a stray clean of the
            # gitignored `.local/`, or a crash between creating a filter and writing the file,
            # leaves one starring mail with no id to find it by. Look for the shape instead.
            note("no armed state recorded — checking the account for stranded probe filters")
            _report_stranded(ensure_token(SCOPE_READ))
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

    subjects: list[dict[str, object]] = []
    if args.domain:
        if args.exclude:
            exclude, exclude_rate = args.exclude, 0
        else:
            picked = _pick_exclusion(token, args.domain)
            if picked is None:
                fail(f"no apex sender at {args.domain} to except — pass --exclude explicitly")
            exclude, exclude_rate = picked
        subjects.append({"domain": args.domain, "exclude": exclude, "excludeCount": exclude_rate})
    else:
        # Best evidence rate first: a subject whose SUBDOMAINS send often answers soonest and
        # keeps confirming. See find_pairs for why subtree volume was the wrong ranking.
        print(f"== choosing the {args.top} subjects with the busiest subdomains ==")
        pairs, _addresses_per_host, per_address = find_pairs(token, args.sample)
        if not pairs:
            fail(
                f"no domain with observed subdomain senders in the last {args.sample} messages\n"
                "       pass --domain explicitly, or raise --sample"
            )
        for pair in pairs[: args.top]:
            domain = str(pair["parent"])
            picked = _pick_exclusion(token, domain)
            if picked is None:
                note(f"skipping {domain} — no apex sender to except, so nothing to prove")
                continue
            exclude, exclude_count = picked
            volume = int(pair["subVolume"])  # type: ignore[arg-type]
            note(
                f"{domain}: subdomains ~{weekly(volume):.1f}/week"
                f" ({', '.join(str(s) for s in pair['subs'])})"  # type: ignore[union-attr]
            )
            note(f"    excepting {exclude} (~{weekly(exclude_count):.1f}/week)")
            subjects.append(
                {
                    "domain": domain,
                    "exclude": exclude,
                    "excludeCount": exclude_count,
                    "subVolume": volume,
                }
            )

        # The two questions have DIFFERENT eligibility. Only a domain with subdomain senders
        # can answer the subdomain question, so the subjects above are chosen for it — but
        # the exclusion question needs no subdomains at all, just two senders at one domain.
        # Left as-is, that half waits on whether the apex senders above happen to write, and
        # apex addresses at these domains are often the quiet ones. Add a domain chosen for
        # the exclusion question outright, so it can answer on its own schedule.
        #
        # Ranked by its BUSIEST SINGLE ADDRESS, not by domain volume: this half waits on one
        # address writing again, so a domain busy across many rarely-writing correspondents is
        # a poor subject however much mail it sends in total. The first live run ranked on
        # domain volume, chose `gmail.com` (24 correspondents), and received nothing from it
        # in five days. The sample is reused rather than re-queried per candidate — measuring
        # every candidate exactly would cost a metadata fetch per message per domain, to order
        # candidates that a 365-day sample already separates clearly.
        chosen = {subject["domain"] for subject in subjects}
        busiest_at: Counter = Counter()
        for address, count in per_address.items():
            host = host_of(address)
            if host not in chosen:
                busiest_at[host] = max(busiest_at[host], count)
        for host, sampled in sorted(busiest_at.items(), key=lambda kv: (-kv[1], kv[0]))[:1]:
            if sampled < 2:
                note("no domain has an address sending often enough to be worth arming")
                break
            picked = _pick_exclusion(token, host)
            if picked is None:
                continue
            exclude, exclude_count = picked
            note(f"{host} — added for the exclusion question alone (no subdomains needed)")
            note(f"    excepting {exclude} (~{weekly(exclude_count):.1f}/week)")
            # subVolume is explicitly null, not absent: this subject has no subdomain rate by
            # design, which `check` must not report as a missing measurement.
            subjects.append(
                {
                    "domain": host,
                    "exclude": exclude,
                    "excludeCount": exclude_count,
                    "subVolume": None,
                }
            )

    if not subjects:
        fail("no usable subject found")

    armed_at = int(time.time())
    for subject in subjects:
        subject["filterId"] = _create_match_filter(
            token, str(subject["domain"]), str(subject["exclude"])
        )
    with open(MATCH_STATE, "w", encoding="utf-8") as handle:
        # Only mail arriving after this point is evidence; anything older predates the filters.
        # The measured rates are stored alongside, so `check` can say whether a null result is
        # the expected wait or a surprise — the first live run could not tell the difference
        # and read as "no answer yet" for five days when one half was never going to answer.
        json.dump({"armedAt": armed_at, "subjects": subjects}, handle)

    print()
    for subject in subjects:
        note(f"armed: from:*@{subject['domain']} except {subject['exclude']} → adds {MATCH_LABEL}")
    note("They star matching mail and nothing else — no message is moved, hidden or deleted.")

    # `or 0` rather than a default: an exclusion-only subject stores subVolume as null, so a
    # dict default would never fire and int(None) would blow up at the end of a successful arm.
    sub_rate = sum(weekly(int(s.get("subVolume") or 0)) for s in subjects)  # type: ignore[arg-type]
    exc_rate = sum(weekly(int(s.get("excludeCount") or 0)) for s in subjects)  # type: ignore[arg-type]
    print()
    note("Expected wait, from the rates measured above:")
    note(f"  subdomains: {_eta(sub_rate)}   (combined ~{sub_rate:.1f} msg/week)")
    note(f"  exception:  {_eta(exc_rate)}   (combined ~{exc_rate:.1f} msg/week)")
    note("These are averages over a quarter, not a schedule — mail arrives in bursts.")
    note("Then:")
    note("  ./scripts/qa-gmail-probe.py match check")
    note("  ./scripts/qa-gmail-probe.py match disarm     # when done (then unstar)")


def _eta(per_week: float) -> str:
    """Plain-language wait for the first message, so a slow subject is obvious up front."""
    if per_week <= 0:
        return "never, on these rates — re-arm with a different subject"
    days = 7.0 / per_week
    if days <= 2:
        return "a day or two"
    if days <= 10:
        return f"about {round(days)} days"
    return f"about {days / 7:.0f} weeks — consider a busier subject"


def _report_stranded(token: str) -> None:
    """Name probe-shaped filters the tool has no record of, without deleting them.

    Deleting on shape alone would mean removing a filter this tool cannot prove it created —
    the exact guess-from-shape that #29 forbids in the app itself, and no more acceptable in
    the QA tool. So it reports and leaves the choice with the user.
    """
    listing = api_get(token, "/settings/filters")
    stranded = [
        f
        for f in listing.get("filter") or []  # type: ignore[union-attr]
        if (f.get("action") or {}).get("addLabelIds") == [MATCH_LABEL]
        and not (f.get("action") or {}).get("removeLabelIds")
        and str((f.get("criteria") or {}).get("from", "")).startswith("*@")
        and (f.get("criteria") or {}).get("negatedQuery")
    ]
    if not stranded:
        note("none found — nothing is starring mail on this tool's behalf")
        return
    note(f"{len(stranded)} filter(s) look like this probe's work but are not recorded:")
    for f in stranded:
        criteria = f.get("criteria") or {}
        note(f"  {f.get('id')}  from:{criteria.get('from')}  except {criteria.get('negatedQuery')}")
    note("Not deleted: shape is not proof this tool made them, and guessing ownership from")
    note("shape is exactly what the app itself refuses to do. Remove any you recognise via")
    note("Gmail's filter settings, or the API.")


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


def _pick_exclusion(token: str, domain: str) -> tuple[str, int] | None:
    """The BUSIEST apex sender at `domain`, with how many messages it sent in the window.

    An exclusion nothing matches proves nothing — and "genuinely sends" has to mean *often*,
    because the exception question needs the excepted address to write AGAIN after arming.
    Taking the alphabetically-first apex address, as this did before, picks an arbitrary one:
    the first live run excepted `amazon-offers@amazon.co.uk` (1 message in 90 days) while
    `shipment-tracking@amazon.co.uk` sent 7, and excepted `cloudplatform-noreply@google.com`
    (1) over `googlestore-noreply@google.com` (5). Both halves sat inconclusive for five days
    with the answer one address away.
    """
    counts = Counter(
        address
        for address in sender_addresses(
            token, f"from:*@{domain} newer_than:{SUBDOMAIN_WINDOW_DAYS}d", 60
        )
        if host_of(address) == domain
    )
    if not counts:
        return None
    # Ties broken alphabetically, so a re-run picks the same subject.
    return min(counts.items(), key=lambda item: (-item[1], item[0]))


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


def _subject_counts(token: str, subject: dict[str, object], armed_at: int) -> tuple[int, int, int, int, int, int]:
    """(apex starred, apex total, sub starred, sub total, excluded starred, excluded total)."""
    domain, exclude = str(subject["domain"]), str(subject["exclude"])
    # `after:` takes seconds; only mail that arrived since arming can be evidence.
    # `after:` narrows the fetch, but the boundary is enforced client-side against
    # `internalDate`: Gmail's date operators are documented at day granularity, and an epoch
    # value there may be rounded to a day boundary in the account's timezone — which would
    # quietly count mail that arrived BEFORE arming, and so never met the filter, as evidence.
    listing = api_get(
        token,
        "/messages",
        {"q": f"from:*@{domain} after:{armed_at}", "maxResults": str(MATCH_PAGE)},
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
        if int(str(meta.get("internalDate", "0")) or 0) < armed_at * 1000:
            continue  # predates the filter; cannot be evidence of what it did
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


def _expected(subject: dict[str, object], key: str, elapsed_days: float, what: str) -> str:
    """How much evidence the armed rate predicted by now — so a null can be read correctly.

    A bare "no evidence yet" is ambiguous three ways: be patient, this subject was never going
    to answer, or this subject was never meant to answer THIS question. The first live run
    spent five days on the wrong side of the middle one. The three states are distinguished by
    the key being absent (armed before rates were recorded), null (the subject is not a
    candidate for this question at all), or a number.
    """
    if key not in subject:
        return f"  {what}: rate unknown (armed before rates were recorded)"
    count = subject[key]
    if count is None:
        return f"  {what}: n/a — this subject was armed for the other question only"
    rate = weekly(int(count))  # type: ignore[arg-type]
    if rate <= 0:
        return f"  {what}: nothing expected — the armed rate was zero"
    predicted = rate * elapsed_days / 7.0
    if predicted < 1:
        return f"  {what}: none expected yet — armed rate predicts ~{predicted:.1f} by now"
    return f"  {what}: ~{predicted:.1f} expected by now at the armed rate — running late"


def _match_report(token: str, state: dict[str, object]) -> None:
    armed_at = int(state["armedAt"])  # type: ignore[arg-type]
    subjects: list[dict[str, object]] = state["subjects"]  # type: ignore[assignment]
    elapsed_days = (int(time.time()) - armed_at) / 86400.0
    print(f"== live filter matching ({elapsed_days:.1f} days since arming) ==")
    note(f"examining up to {MATCH_PAGE} messages per subject")

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
        if apex_t and apex_s == apex_t:
            # The positive control. Without it a run of zeroes is indistinguishable from a
            # filter that was never created, or was created wrong — and "the filter matches
            # nothing" is the one explanation the other lines cannot rule out.
            note(f"  control:    filter IS live — it starred all {apex_t} apex message(s)")
        elif apex_t:
            note(f"  control:    only {apex_s}/{apex_t} apex message(s) starred — investigate")
            note("              this before reading anything into the lines above")
        if sub_t == 0:
            note("  subdomains: no evidence yet")
            note(_expected(subject, "subVolume", elapsed_days, "            predicted"))
        elif sub_s == sub_t:
            spans.append(True)
            note(f"  subdomains: REACHED by the filter (from {sub_t} message(s))")
        elif sub_s == 0:
            spans.append(False)
            note(f"  subdomains: NOT reached (from {sub_t} message(s))")
        else:
            note("  subdomains: mixed — record which senders matched; not a clean answer")
        if exc_t == 0:
            note("  exception:  no evidence yet")
            note(_expected(subject, "excludeCount", elapsed_days, "            predicted"))
        else:
            spares.append(exc_s == 0)
            note(
                "  exception:  "
                + ("SPARED" if exc_s == 0 else "NOT spared")
                + f" (from {exc_t} message(s))"
            )

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

    psl = sub.add_parser("psl", help="does Gmail's matcher respect public-suffix boundaries?")
    psl.add_argument("--domain", help="test ONE host (skips the mailbox sample)")
    psl.add_argument("--sample", type=int, default=400)
    psl.add_argument("--top", type=int, default=3, help="how many suffixes to probe")
    psl.add_argument("--corpus", default=PSL_CORPUS, help="PSL corpus from fetch-psl-corpus.sh")
    psl.set_defaults(func=cmd_psl)

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
