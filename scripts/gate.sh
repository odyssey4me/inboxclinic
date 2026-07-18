#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Local CI gate — run the gate inside a container
# -----------------------------------------------------------------------------
# Reproduces the CI gate (.github/workflows/ci.yml: build + e2e + docs) locally in
# a container, so "green locally" reliably means "green on the gate". In particular
# it runs the FULL Playwright matrix incl. WebKit, which can't launch on a Fedora
# host (missing apt-only deps like libwoff1) — the exact gap that let a mobile-only
# selector bug reach the gate (#106).
#
# Base image: the official Playwright image pinned to this repo's @playwright/test
# version (read from package.json), whose baked-in browsers match CI's
# `playwright install --with-deps`. When @playwright/test bumps, the tag follows
# automatically — no silent drift.
#
# See CONTRIBUTING.md (Development setup → Checks) and issue #107.
#
# Usage:
#   ./scripts/gate.sh              # full gate: checks + lint + typecheck + tests + build + e2e + doc-sync
#   ./scripts/gate.sh --e2e-only   # just build + the Playwright matrix (the container-only part)
#   ./scripts/gate.sh --no-e2e     # everything except e2e (fast inner-loop)
#   ./scripts/gate.sh --print      # print the resolved engine/image/command without running
#
# Env:
#   CONTAINER_ENGINE   engine override (default: podman if present, else docker)
# -----------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="full"
PRINT_ONLY=0
case "${1:-}" in
  --e2e-only) MODE="e2e" ;;
  --no-e2e) MODE="checks" ;;
  --print) PRINT_ONLY=1 ;;
  "" | --full) MODE="full" ;;
  -h | --help)
    sed -n '2,/^# ---/p' "$0" | sed 's/^# \{0,1\}//;/^---/d'
    exit 0
    ;;
  *)
    echo "gate.sh: unknown option '$1' (see --help)" >&2
    exit 2
    ;;
esac

# Container engine — podman (the maintainer's rootless engine) first, docker as fallback.
ENGINE="${CONTAINER_ENGINE:-}"
if [[ -z "$ENGINE" ]]; then
  if command -v podman >/dev/null 2>&1; then
    ENGINE="podman"
  elif command -v docker >/dev/null 2>&1; then
    ENGINE="docker"
  else
    echo "gate.sh: need podman or docker on PATH (or set CONTAINER_ENGINE)" >&2
    exit 1
  fi
fi

# Pin the image to our Playwright version so the baked-in browsers match CI exactly.
PW_VERSION="$(node -p "require('./package.json').devDependencies['@playwright/test'].replace(/[^0-9.]/g,'')" 2>/dev/null || true)"
if [[ -z "$PW_VERSION" ]]; then
  echo "gate.sh: could not read @playwright/test version from package.json" >&2
  exit 1
fi
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

# The Playwright image bundles a newer Node than this repo pins (`.nvmrc` + engine-strict),
# so install the pinned Node over it via `n` before `npm ci` — same Node as CI's setup-node.
NODE_V="$(cat .nvmrc)"
NODE_SETUP="export N_PREFIX=/usr/local; npm install -g n >/dev/null 2>&1; n ${NODE_V} >/dev/null 2>&1; export PATH=/usr/local/bin:\$PATH; hash -r; node --version"

# Steps mirror the three gate jobs. `npm ci` matches CI; the official image already carries
# the browsers, so no `playwright install` step is needed.
CHECKS='./scripts/check-no-secrets.sh && ./scripts/check-no-dup-majors.sh && npm run lint && npm run typecheck && npm run test:coverage && npm run build && ./scripts/doc-sync-validate.sh'
E2E='npm run e2e'
case "$MODE" in
  full) STEPS="${NODE_SETUP} && npm ci && ${CHECKS} && ${E2E}" ;;
  checks) STEPS="${NODE_SETUP} && npm ci && ${CHECKS}" ;;
  e2e) STEPS="${NODE_SETUP} && npm ci && ${E2E}" ;;
esac

# Named volumes keep the container's (Ubuntu) node_modules + npm cache off the host
# (Fedora) tree and cache them across runs. One volume per workspace so nothing native
# to the container is written into the bind-mounted repo.
VOLS=(-v "inboxclinic-gate-nm-root:/work/node_modules")
for pkg in apps/*/ packages/*/; do
  [[ -f "${pkg}package.json" ]] || continue
  slug="inboxclinic-gate-nm-$(printf '%s' "${pkg%/}" | tr '/' '-')"
  VOLS+=(-v "${slug}:/work/${pkg}node_modules")
done
VOLS+=(-v "inboxclinic-gate-npm-cache:/root/.npm")
VOLS+=(-v "inboxclinic-gate-n-cache:/usr/local/n") # cache the `n`-installed Node across runs

# Rootless podman maps container-root → the host user, so files written into the
# bind-mounted repo stay host-owned; `:Z` relabels the mount for SELinux (Fedora).
REPO_MOUNT="$PWD:/work"
[[ "$ENGINE" == "podman" ]] && REPO_MOUNT="$PWD:/work:Z"

RUN=(
  "$ENGINE" run --rm
  -v "$REPO_MOUNT"
  "${VOLS[@]}"
  -w /work
  -e CI=1
  "$IMAGE"
  bash -lc "set -euo pipefail; ${STEPS}"
)

echo "gate.sh: engine=$ENGINE  image=$IMAGE  mode=$MODE"
if [[ "$PRINT_ONLY" == "1" ]]; then
  printf '%q ' "${RUN[@]}"
  echo
  exit 0
fi
exec "${RUN[@]}"
