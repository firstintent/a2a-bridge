#!/usr/bin/env bash
# check-release-ready.sh — pre-release gate for a2a-bridge (P7.6).
#
# Asserts every precondition the release runbook
# (`docs/release/PUBLISH.md`) expects to hold before a maintainer
# cuts a tag. Exits non-zero on the first failure so `set -e` callers
# stop immediately.
#
# Checks performed:
#   1. Version alignment across package.json / plugin.json /
#      marketplace.json (via `scripts/check-plugin-versions.js`).
#   2. CHANGELOG.md has a `## [<version>]` section for the current
#      package.json version.
#   3. `bun run check:ci` is green (typecheck + lint:deps +
#      test:unit + build:plugin + version-check + smoke-tarball +
#      smoke-e2e — the full CI gate, identical to what release.yml
#      runs on the tag push).
#   4. Every release artifact the runbook references is present:
#        release/acp-registry/agent.json
#        release/acp-registry/icon.svg
#        release/acp-registry/README.md
#        release/marketplace/SUBMIT.md
#        docs/release/PUBLISH.md
#
# Run from the repo root:
#   bash scripts/check-release-ready.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

fail() {
  echo "[release-ready] FAIL: $1" >&2
  exit 1
}

section() {
  echo ""
  echo "[release-ready] $1"
}

# ---------- 1. Version alignment -----------------------------------

section "1/4 Version alignment (package.json / plugin.json / marketplace.json)"
bun scripts/check-plugin-versions.js

VERSION=$(bun -e 'console.log(require("./package.json").version)')
echo "[release-ready] package version: $VERSION"

# ---------- 2. CHANGELOG has an entry ------------------------------

section "2/4 CHANGELOG.md has an entry for $VERSION"
if [ ! -f CHANGELOG.md ]; then
  fail "CHANGELOG.md is missing"
fi
if ! grep -qE "^## \[$VERSION\]" CHANGELOG.md; then
  fail "CHANGELOG.md has no '## [$VERSION]' header"
fi
echo "[release-ready] CHANGELOG.md: '## [$VERSION]' header present"

# ---------- 3. bun run check:ci ------------------------------------

section "3/4 bun run check:ci (includes tarball smoke)"
bun run check:ci

# ---------- 4. Required release artifacts --------------------------

section "4/4 Required release/ + docs/release/ artifacts"
REQUIRED_ARTIFACTS=(
  "release/acp-registry/agent.json"
  "release/acp-registry/icon.svg"
  "release/acp-registry/README.md"
  "release/marketplace/SUBMIT.md"
  "docs/release/PUBLISH.md"
)
missing=0
for f in "${REQUIRED_ARTIFACTS[@]}"; do
  if [ ! -f "$f" ]; then
    echo "[release-ready] FAIL: missing $f" >&2
    missing=$((missing + 1))
  else
    echo "[release-ready]   ok: $f"
  fi
done
if [ "$missing" -gt 0 ]; then
  fail "$missing required artifact(s) missing"
fi

echo ""
echo "[release-ready] OK — $VERSION is cleared for tag + release.yml"
