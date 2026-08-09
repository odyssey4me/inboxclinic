#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Gmail behaviour probe (manual QA against a real account)
# -----------------------------------------------------------------------------
# The fourth, manual, non-gating test tier — see docs/design-testing.md
# (Decision 9: Real-account probes for undocumented provider behaviour), which
# owns this script's design criteria: read-only wherever the question allows,
# least-privilege short-lived credentials, metadata-only reads, never
# destructive, and evidence over verdicts.
#
# It answers what Google does not document and no emulator reproduces, and what
# mocking the GmailClient port can therefore only encode as a belief:
#
#   discover Samples the mailbox and reports domains that ACTUALLY have mail from
#            both themselves and their subdomains, plus example addresses — so
#            the probes below can be pointed at real subjects instead of guessed
#            ones. Pure observation.                          [gmail.readonly]
#   search   Does `from:*@domain` behave as a wildcard, and does it span
#            SUBDOMAINS? Prints the distinct sender domains a domain query really
#            returns, and checks a `-from:(a OR b)` exclusion excludes.
#                                                            [gmail.readonly]
#   filters  Reads the account's existing filters and checks every stored
#            `criteria.negatedQuery` still parses as `from:(...)` — the shape
#            `unwrapExcludeFrom` needs and the reconcile signature depends on. If
#            Gmail ever reformats what we send, this is where it shows, without
#            creating anything. With --json it also DUMPS the account's filters
#            in the port's NativeFilter shape, so the real, messy rule set can be
#            replayed through the compiler and the consolidation/adoption
#            suggesters offline — see the analysis spec named below.
#                                                             [gmail.readonly]
#   limit    Where does Gmail actually reject an over-long filter? Binary-searches
#            the criteria budget `DEFAULT_MAX_CRITERIA_CHARS` guesses at. Nothing
#            existing answers this, so it creates and immediately deletes probe
#            filters against an unroutable domain — the only probe needing write
#            scope, and opt-in at the command line.
#                                              [gmail.settings.basic, --i-know]
#
# The semantics under test, and why enforcement depends on them, are in
# docs/design-gmail-integration.md (Decision 5).
#
# Replaying a dump through the real code:
#   ./scripts/qa-gmail-probe.sh filters --json --out .local/filters.json
#   INBOXCLINIC_FILTER_FIXTURE=.local/filters.json npx vitest run realFilters
# (dumps carry your own sender addresses — .local/ is gitignored, keep it there)
#
# Auth: a short-lived (~1h) user credential minted by the Google CLI, which must
# already be installed and logged in. `login` requests read-only scope alone
# unless `--with-filters` is passed. The token is never printed, and never
# written to the repo.
#
# The CLI's BUILT-IN OAuth client cannot be used for this: it mandates the
# `cloud-platform` scope, so a Gmail probe would also carry broad Google Cloud
# access to the account. The CLI's own documentation directs non-GCP scopes to
# `--client-id-file` with your own OAuth client, which is what keeps this to
# `gmail.readonly`. One-time setup, in the Cloud project that already hosts the
# app's OAuth client:
#
#   Credentials -> Create credentials -> OAuth client ID -> Desktop app
#   Download the JSON to .local/oauth-client.json (gitignored)
#
# `--allow-cloud-scope` falls back to the built-in client and its mandatory
# `cloud-platform` grant. It exists for a quick one-off; it is not the intended
# path, and the script says so each time.
#
# Usage:
#   ./scripts/qa-gmail-probe.sh login [--with-filters] [--client-id-file F]
#   ./scripts/qa-gmail-probe.sh discover [--sample 200]
#   ./scripts/qa-gmail-probe.sh search [--domain x.com] [--exclude a@x.com]
#   ./scripts/qa-gmail-probe.sh filters [--json] [--out FILE]
#   ./scripts/qa-gmail-probe.sh limit --i-know [--domain probe.invalid]
#   ./scripts/qa-gmail-probe.sh revoke                   # drop the credential
# -----------------------------------------------------------------------------
set -euo pipefail

SCOPE_READ="https://www.googleapis.com/auth/gmail.readonly"
SCOPE_FILTERS="https://www.googleapis.com/auth/gmail.settings.basic"
API="https://gmail.googleapis.com/gmail/v1/users/me"
TOKENINFO="https://oauth2.googleapis.com/tokeninfo"
SCOPE_CLOUD="https://www.googleapis.com/auth/cloud-platform"

DOMAIN=""
EXCLUDE=""
WITH_FILTERS=0
CONFIRM_WRITE=0
AS_JSON=0
ALLOW_CLOUD=0
CLIENT_ID_FILE=""
DEFAULT_CLIENT_ID_FILE=".local/oauth-client.json"
OUT_FILE=""
MAX_RESULTS=50
SAMPLE=200
DISCOVERED_ADDRESSES=""
DISCOVERED_COUNTS=()
LAST_ERROR=""

die() {
  echo "error: $*" >&2
  exit 1
}
note() { echo "  $*"; }

usage() {
  # The banner is the documentation; print it rather than duplicating it here.
  awk 'NR>4 && /^# ---/ {exit} NR>2 {sub(/^# ?/, ""); print}' "$0"
  exit "${1:-0}"
}

# --- auth -------------------------------------------------------------------

# The credential's remaining life, or "dead". The CLI refreshes an expired access
# token by itself, so what actually goes stale is the underlying grant — revoked
# in the Google account, expired, or scoped for a different purpose. Both failure
# modes surface here rather than as an opaque 401 mid-probe.
credential_seconds_left() {
  local token info
  token=$(gcloud auth application-default print-access-token 2>/dev/null) || {
    echo "dead"
    return
  }
  info=$(curl -sS --max-time 15 "${TOKENINFO}?access_token=${token}" 2>/dev/null) || {
    echo "dead"
    return
  }
  [[ $(jq -r '.error // ""' <<<"${info}") == "" ]] || {
    echo "dead"
    return
  }
  jq -r '.expires_in // 0' <<<"${info}"
}

# Remove a credential that can no longer be used, so the next run starts clean
# instead of re-failing against a dead grant.
clear_credential() {
  gcloud auth application-default revoke --quiet >/dev/null 2>&1 || true
  rm -f "${HOME}/.config/gcloud/application_default_credentials.json"
}

# Establish $TOKEN for a probe, or exit with what to do about it. Never echoes
# the token; the CLI owns its lifetime.
ensure_credential() {
  local needed="$1" left granted extra=""
  [[ ${needed} == "${SCOPE_FILTERS}" ]] && extra=" --with-filters"

  left=$(credential_seconds_left)
  if [[ ${left} == "dead" ]]; then
    note "credential is expired or revoked — clearing it"
    clear_credential
    die "no usable credential — run: ./scripts/qa-gmail-probe.sh login${extra}"
  fi

  TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null)
  granted=$(curl -sS --max-time 15 "${TOKENINFO}?access_token=${TOKEN}" | jq -r '.scope // ""')
  [[ " ${granted} " == *" ${needed} "* ]] ||
    die "credential lacks ${needed} — re-run: ./scripts/qa-gmail-probe.sh login${extra}"

  ((left < 300)) && note "note: this credential expires in ${left}s; re-run login if a probe fails part-way"
  return 0
}

cmd_login() {
  local scopes="openid,https://www.googleapis.com/auth/userinfo.email,${SCOPE_READ}"
  local client_file=${CLIENT_ID_FILE:-${DEFAULT_CLIENT_ID_FILE}}

  if ((WITH_FILTERS)); then
    scopes="${scopes},${SCOPE_FILTERS}"
    echo "Requesting read scope + filter WRITE scope (${SCOPE_FILTERS})."
    echo "Only the 'limit' probe needs write; the others do not."
  else
    echo "Requesting read-only scope (${SCOPE_READ})."
  fi

  if [[ -f ${client_file} ]]; then
    echo "Using your OAuth client (${client_file}) — Gmail scopes only."
    gcloud auth application-default login \
      --client-id-file="${client_file}" --scopes="${scopes}"
  elif ((ALLOW_CLOUD)); then
    # The built-in client refuses to mint a credential without cloud-platform, so
    # this path grants far more than a mailbox probe needs.
    echo
    echo "WARNING: falling back to the CLI's built-in OAuth client, which requires"
    echo "         ${SCOPE_CLOUD}"
    echo "         The credential will also carry broad Google Cloud access to this"
    echo "         account. Revoke as soon as you are done."
    echo
    gcloud auth application-default login --scopes="${scopes},${SCOPE_CLOUD}"
  else
    die "no OAuth client file at ${client_file}.

       The CLI's built-in client mandates ${SCOPE_CLOUD},
       which would hand a mailbox probe broad Google Cloud access. To keep this to
       Gmail scopes, create a Desktop OAuth client once — in the Cloud project that
       already hosts the app's client:

         Credentials -> Create credentials -> OAuth client ID -> Desktop app

       Download the JSON to ${DEFAULT_CLIENT_ID_FILE} (gitignored), then re-run login.
       Pass --client-id-file to use a different path, or --allow-cloud-scope to accept
       the broader grant instead."
  fi
  echo
  echo "Done. Revoke when finished:  ./scripts/qa-gmail-probe.sh revoke"
}

cmd_revoke() {
  clear_credential
  echo "Credential cleared. Also review https://myaccount.google.com/permissions"
}

# --- api helpers ------------------------------------------------------------

urlencode() { jq -rR @uri <<<"$1"; }

api_get() { curl -sS --max-time 30 -H "Authorization: Bearer ${TOKEN}" "${API}$1"; }

# The `From` domains a query actually returns — metadata only.
sender_domains_for_query() {
  local query="$1" ids id
  ids=$(api_get "/messages?maxResults=${MAX_RESULTS}&q=$(urlencode "${query}")" |
    jq -r '.messages[]?.id')
  [[ -z ${ids} ]] && return 0
  while read -r id; do
    api_get "/messages/${id}?format=metadata&metadataHeaders=From" |
      jq -r '.payload.headers[]? | select(.name|ascii_downcase=="from") | .value' |
      sed -n 's/.*@\([A-Za-z0-9.-]*\).*/\1/p' | tr 'A-Z' 'a-z'
  done <<<"${ids}"
}

# Sender addresses from a sample of recent mail — metadata only, lowercased.
# `From` is either `Name <a@b.com>` or a bare address.
sender_addresses_sample() {
  local limit="$1" ids id
  ids=$(api_get "/messages?maxResults=${limit}&q=$(urlencode "newer_than:180d")" |
    jq -r '.messages[]?.id')
  [[ -z ${ids} ]] && return 0
  while read -r id; do
    api_get "/messages/${id}?format=metadata&metadataHeaders=From" |
      jq -r '.payload.headers[]? | select(.name|ascii_downcase=="from") | .value' |
      sed -e 's/.*<\(.*\)>.*/\1/' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' |
      grep -F '@' | tr 'A-Z' 'a-z'
  done <<<"${ids}"
}

# --- probes -----------------------------------------------------------------

# Which domains are worth probing? Only ones where this mailbox actually holds
# mail from a domain AND from something beneath it. Parent/child is decided by
# label-boundary suffix matching between observed hosts — no public-suffix list
# needed, and nothing hard-coded: if `email.x.com` and `x.com` both sent mail,
# `x.com` is a real subject for the subdomain question.
#
# Emits TSV: parent, comma-separated subdomains, an example subdomain address,
# apex sender count — richest candidate first.
discover_pairs() {
  local addresses addr host parent child
  addresses=$(sender_addresses_sample "${SAMPLE}" | sort -u)
  [[ -n ${addresses} ]] || return 0

  declare -A example_for=() count_for=()
  while read -r addr; do
    host=${addr##*@}
    [[ -n ${host} ]] || continue
    count_for["${host}"]=$((${count_for["${host}"]:-0} + 1))
    [[ -n ${example_for["${host}"]:-} ]] || example_for["${host}"]="${addr}"
  done <<<"${addresses}"

  # Exported for the ranking section of `discover`, which reuses this sample.
  DISCOVERED_ADDRESSES=${addresses}
  for host in "${!count_for[@]}"; do
    DISCOVERED_COUNTS+=("${count_for[${host}]}"$'\t'"${host}"$'\t'"${example_for[${host}]}")
  done

  local hosts
  hosts=$(printf '%s\n' "${!count_for[@]}" | sort)
  while read -r parent; do
    local subs="" sub_example="" n=0
    while read -r child; do
      [[ ${child} == "${parent}" ]] && continue
      # Label-boundary suffix only: `notmonzo.com` is not under `monzo.com`.
      if [[ ${child} == *".${parent}" ]]; then
        subs+="${subs:+, }${child}"
        ((n++))
        [[ -n ${sub_example} ]] || sub_example=${example_for["${child}"]}
      fi
    done <<<"${hosts}"
    [[ -n ${subs} ]] &&
      printf '%s\t%s\t%s\t%s\t%s\n' "${n}" "${parent}" "${subs}" "${sub_example}" "${count_for["${parent}"]:-0}"
  done <<<"${hosts}" | sort -rn
}

cmd_discover() {
  ensure_credential "${SCOPE_READ}"

  echo "== sampling up to ${SAMPLE} recent messages (metadata only) =="
  local pairs
  DISCOVERED_COUNTS=()
  pairs=$(discover_pairs)

  echo
  echo "-- domains with mail from BOTH themselves and a subdomain (ideal subjects)"
  if [[ -z ${pairs} ]]; then
    note "none in this sample — try a larger --sample"
  else
    while IFS=$'\t' read -r _n parent subs sub_example apex; do
      note "${parent}  (apex senders: ${apex})"
      note "  subdomains seen: ${subs}"
      note "  probe it:  ./scripts/qa-gmail-probe.sh search --domain ${parent} --exclude ${sub_example}"
    done <<<"${pairs}"
  fi

  echo
  echo "-- domains with the most distinct sender addresses (exclusion subjects)"
  printf '%s\n' "${DISCOVERED_COUNTS[@]}" | sort -rn | head -5 |
    while IFS=$'\t' read -r n host example; do
      note "${host}  (${n} distinct address(es), e.g. ${example})"
    done
}

cmd_search() {
  ensure_credential "${SCOPE_READ}"

  # No subject given? Find one in the mailbox rather than making the caller guess,
  # or worse, baking a domain into the script.
  if [[ -z ${DOMAIN} ]]; then
    echo "== no --domain given; discovering a subject from the mailbox =="
    local best
    DISCOVERED_COUNTS=()
    best=$(discover_pairs | head -1)
    [[ -n ${best} ]] || die "no domain with observed subdomain senders in the last ${SAMPLE} messages
       pass --domain explicitly, or raise --sample"
    IFS=$'\t' read -r _ DOMAIN _subs auto_exclude _apex <<<"${best}"
    [[ -n ${EXCLUDE} ]] || EXCLUDE=${auto_exclude}
    note "chose ${DOMAIN} (excluding ${EXCLUDE})"
    echo
  fi

  echo "== search semantics for ${DOMAIN} =="
  echo
  echo "-- from:*@${DOMAIN} — is \`*@\` a wildcard, and does it span subdomains?"
  local domains
  domains=$(sender_domains_for_query "from:*@${DOMAIN}" | sort | uniq -c | sort -rn)
  if [[ -z ${domains} ]]; then
    note "NO RESULTS — either no such mail, or \`*@\` is not treated as a wildcard."
    note "Check by hand before concluding: a literal \`*\` returns zero, exactly like an empty mailbox."
  else
    echo "${domains}" | while read -r count host; do
      if [[ ${host} == "${DOMAIN}" ]]; then
        note "${count}x ${host}   (the domain itself)"
      else
        note "${count}x ${host}   << SUBDOMAIN/OTHER — matched by a query for ${DOMAIN}"
      fi
    done
    echo
    note "Any SUBDOMAIN line means a domain block sweeps senders the user never decided on."
  fi

  if [[ -n ${EXCLUDE} ]]; then
    echo
    echo "-- from:*@${DOMAIN} -from:(${EXCLUDE}) — does the parenthesised exclusion apply?"
    local before after host
    host=${EXCLUDE##*@}
    before=$(sender_domains_for_query "from:*@${DOMAIN}" | grep -c "^${host}$" || true)
    after=$(sender_domains_for_query "from:*@${DOMAIN} -from:(${EXCLUDE})" | grep -c "^${host}$" || true)
    note "messages from ${host}: ${before} without the exclusion, ${after} with it"
    if ((before == 0)); then
      note "INCONCLUSIVE — nothing to exclude; pick an address you do receive mail from."
    elif ((after == 0)); then
      note "PASS — the exclusion removed them."
    else
      note "FAIL — the exclusion did NOT remove them."
    fi
  fi
}

# Read-only round-trip check. Reconcile compares against list(), so the STORED
# value is the one that decides — a create response echoing its own request would
# look fine here and still churn in production. Any filter carrying a
# negatedQuery is evidence, whoever made it.
cmd_filters() {
  ensure_credential "${SCOPE_READ}"

  local filters_raw
  filters_raw=$(api_get "/settings/filters")

  if ((AS_JSON)); then
    # Normalise into the port's NativeFilter shape — including unwrapping
    # `from:(...)` back to bare addresses exactly as the browser client does — so
    # the dump can be fed to the real compiler/suggesters unchanged.
    local dump
    dump=$(jq '[ .filter[]?
      | (.criteria.negatedQuery // "") as $n
      | { id,
          from: (.criteria.from // ""),
          excludeFrom: (
            if ($n | test("^from:\\(.*\\)$"))
            then ($n | sub("^from:\\("; "") | sub("\\)$"; ""))
            elif $n == "" then null
            else $n end),
          addLabelIds: (.action.addLabelIds // []),
          removeLabelIds: (.action.removeLabelIds // []) } ]' <<<"${filters_raw}")
    if [[ -n ${OUT_FILE} ]]; then
      mkdir -p "$(dirname "${OUT_FILE}")"
      printf '%s\n' "${dump}" >"${OUT_FILE}"
      note "wrote $(jq length <<<"${dump}") filter(s) to ${OUT_FILE}"
      note "replay: INBOXCLINIC_FILTER_FIXTURE=${OUT_FILE} npx vitest run realFilters"
    else
      printf '%s\n' "${dump}"
    fi
    return 0
  fi

  echo "== stored filter criteria (read-only) =="
  local filters count
  filters=${filters_raw}
  if [[ $(jq -r '.error.code // ""' <<<"${filters}") == "403" ]]; then
    die "listing filters was refused with read-only scope: $(jq -r '.error.message' <<<"${filters}")
       re-run: ./scripts/qa-gmail-probe.sh login --with-filters"
  fi

  count=$(jq '[.filter[]? | select(.criteria.negatedQuery != null)] | length' <<<"${filters}")
  jq -r '.filter[]? | "\(.id)\t\(.criteria.from // "-")\t\(.criteria.negatedQuery // "-")"' <<<"${filters}" |
    while IFS=$'\t' read -r id from neg; do
      note "${id}"
      note "  from:         ${from}"
      note "  negatedQuery: ${neg}"
      if [[ ${neg} != "-" ]]; then
        # `unwrapExcludeFrom` parses exactly this shape; anything else means the
        # reconcile signature can't reproduce `excludeFrom` and filters churn.
        if [[ ${neg} =~ ^from:\(.*\)$ ]]; then
          note "  shape:        OK — matches ^from:\\((.*)\\)\$"
        else
          note "  shape:        MISMATCH — unwrapExcludeFrom would not recover excludeFrom from this"
        fi
      fi
    done

  echo
  if ((count == 0)); then
    note "No filter carries a negatedQuery, so round-trip fidelity is untested here."
    note "Create one (Gmail UI or API Explorer), then re-run — or use a filter the app itself made."
  else
    note "${count} filter(s) with a negatedQuery inspected."
    note "Compare the printed value against what was SENT: it must match byte-for-byte,"
    note "including term order and the spacing around OR."
  fi
}

cmd_limit() {
  ((CONFIRM_WRITE)) || die "limit creates and deletes probe filters — pass --i-know to confirm.
       The other probes are read-only; this one cannot be."
  local domain=${DOMAIN:-probe.invalid}
  [[ ${domain} == *.invalid ]] ||
    note "WARNING: ${domain} can receive mail; probe filters will briefly exist against it."
  ensure_credential "${SCOPE_FILTERS}"

  echo "== criteria length limit on ${domain} (DEFAULT_MAX_CRITERIA_CHARS assumes 1500) =="
  local lo=100 hi=4000 mid last_ok=0 first_fail=0

  probe_len() {
    local target=$1 from="*@${domain}" neg="" addr i=0 tmp code id
    while ((${#from} + 7 + ${#neg} < target)); do
      addr="p$(printf '%04d' "${i}")@${domain}"
      neg="${neg:+${neg} OR }${addr}"
      ((i++))
      ((i > 500)) && break
    done
    tmp=$(mktemp)
    code=$(curl -sS --max-time 30 -o "${tmp}" -w "%{http_code}" \
      -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      --data "$(jq -nc --arg from "${from}" --arg neg "from:(${neg})" \
        '{criteria:{from:$from,negatedQuery:$neg},action:{addLabelIds:["STARRED"]}}')" \
      "${API}/settings/filters")
    if [[ ${code} == 200 ]]; then
      id=$(jq -r .id "${tmp}")
      curl -sS -X DELETE -H "Authorization: Bearer ${TOKEN}" \
        "${API}/settings/filters/${id}" >/dev/null 2>&1 || true
      rm -f "${tmp}"
      return 0
    fi
    LAST_ERROR=$(jq -r '.error.message // "?"' "${tmp}")
    rm -f "${tmp}"
    return 1
  }

  if ! probe_len "${lo}"; then
    note "even ${lo} chars was rejected: ${LAST_ERROR:-?}"
    return 1
  fi
  last_ok=${lo}
  while ((hi - lo > 25)); do
    mid=$(((lo + hi) / 2))
    if probe_len "${mid}"; then
      lo=${mid}
      last_ok=${mid}
    else
      hi=${mid}
      first_fail=${mid}
    fi
  done
  note "largest accepted criteria: ~${last_ok} chars"
  ((first_fail)) && note "smallest rejected:         ~${first_fail} chars (${LAST_ERROR:-?})"
  echo
  note "Well below 1500 ⇒ DEFAULT_MAX_CRITERIA_CHARS is too generous and #191 still bites."
  note "Well above     ⇒ domains degrade to enumerate form earlier than they need to."
}

# --- args -------------------------------------------------------------------

[[ $# -gt 0 ]] || usage 1
COMMAND=$1
shift
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)
      DOMAIN=$2
      shift 2
      ;;
    --exclude)
      EXCLUDE=$2
      shift 2
      ;;
    --sample)
      SAMPLE=$2
      shift 2
      ;;
    --with-filters)
      WITH_FILTERS=1
      shift
      ;;
    --i-know)
      CONFIRM_WRITE=1
      shift
      ;;
    --json)
      AS_JSON=1
      shift
      ;;
    --out)
      OUT_FILE=$2
      shift 2
      ;;
    --client-id-file)
      CLIENT_ID_FILE=$2
      shift 2
      ;;
    --allow-cloud-scope)
      ALLOW_CLOUD=1
      shift
      ;;
    -h | --help) usage 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

command -v gcloud >/dev/null || die "the Google CLI (gcloud) is required and must already be logged in"
command -v jq >/dev/null || die "jq is required"

case ${COMMAND} in
  login) cmd_login ;;
  revoke) cmd_revoke ;;
  discover) cmd_discover ;;
  search) cmd_search ;;
  filters) cmd_filters ;;
  limit) cmd_limit ;;
  -h | --help) usage 0 ;;
  *) die "unknown command: ${COMMAND}" ;;
esac
