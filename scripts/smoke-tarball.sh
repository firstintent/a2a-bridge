#!/usr/bin/env bash
# smoke-tarball.sh — verify the packaged CLI works end-to-end (P6.7).
#
# Runs `npm pack`, installs the resulting tarball into a throwaway
# temp directory, then invokes the three read-only probe commands
# that every release must answer correctly:
#
#   a2a-bridge --version     — prints something that looks like a version
#   a2a-bridge init --print  — mints/reuses a bearer token + prints snippets
#   a2a-bridge doctor        — preflight checklist (exit 0 when required checks pass)
#
# The script sets `A2A_BRIDGE_STATE_DIR` to an isolated tmp path so
# running it does not rotate or reuse the user's real state-dir
# config. Any non-zero exit fails the smoke test.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/a2a-bridge-smoke.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

echo "[smoke] building dist/cli.js + plugin bundles..."
bun run build:cli >/dev/null
bun run build:plugin >/dev/null

echo "[smoke] packing tarball..."
# Hooks (`prepare` for our git-hooks installer) can print extra lines
# during `npm pack`; keep only the tarball filename off the last line.
TARBALL=$(cd "$WORK" && npm pack --silent "$PROJECT_ROOT" | tail -n 1)
TARBALL_PATH="$WORK/$TARBALL"
test -f "$TARBALL_PATH" || { echo "[smoke] FAIL: tarball not produced ($TARBALL)"; exit 1; }
echo "[smoke] packed: $TARBALL_PATH"

echo "[smoke] installing into $WORK/install ..."
mkdir -p "$WORK/install"
(
  cd "$WORK/install"
  npm init -y >/dev/null
  npm install --silent --no-audit --no-fund --loglevel=error "$TARBALL_PATH"
)

BIN="$WORK/install/node_modules/.bin/a2a-bridge"
test -x "$BIN" || { echo "[smoke] FAIL: $BIN not executable"; exit 1; }

export A2A_BRIDGE_STATE_DIR="$WORK/state"
mkdir -p "$A2A_BRIDGE_STATE_DIR"

echo "[smoke] a2a-bridge --version"
VERSION=$("$BIN" --version)
echo "  $VERSION"
echo "$VERSION" | grep -Eq 'a2a-bridge v[0-9]+\.[0-9]+\.[0-9]+' \
  || { echo "[smoke] FAIL: --version output did not match 'a2a-bridge vX.Y.Z'"; exit 1; }

echo "[smoke] a2a-bridge init --print"
"$BIN" init --print >"$WORK/init.out"
grep -q 'Bearer token' "$WORK/init.out" \
  || { echo "[smoke] FAIL: init --print did not print bearer token line"; cat "$WORK/init.out"; exit 1; }
grep -q 'remoteAgents' "$WORK/init.out" \
  || { echo "[smoke] FAIL: init --print did not print Gemini snippet"; exit 1; }

echo "[smoke] a2a-bridge doctor"
"$BIN" doctor

echo "[smoke] OK"
