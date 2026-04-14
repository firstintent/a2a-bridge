#!/usr/bin/env bash
# a2a-bridge one-line installer for the Claude Code (server) side.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/firstintent/a2a-bridge/main/scripts/install.sh | bash
#
# What it does:
#   1. Checks prerequisites (bun, node/npm, claude)
#   2. Installs a2a-bridge globally via npm
#   3. Runs `a2a-bridge init` (mints bearer token + installs CC plugin)
#   4. Prints next-step instructions
#
# Safe to re-run — `npm i -g` upgrades in place, `init` is idempotent.

set -euo pipefail

# Colors (fallback to plain if terminal doesn't support them)
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  BOLD=$(tput bold)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  RED=$(tput setaf 1)
  RESET=$(tput sgr0)
else
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
fi

info()  { echo "${GREEN}✓${RESET} $*"; }
warn()  { echo "${YELLOW}!${RESET} $*"; }
fail()  { echo "${RED}✗${RESET} $*"; exit 1; }

echo ""
echo "${BOLD}a2a-bridge installer${RESET}"
echo ""

# --- Prerequisites -----------------------------------------------------------

# bun
if command -v bun >/dev/null 2>&1; then
  BUN_VER=$(bun --version 2>/dev/null || echo "unknown")
  info "bun $BUN_VER"
else
  fail "bun not found. Install: https://bun.sh/docs/installation"
fi

# npm
if command -v npm >/dev/null 2>&1; then
  info "npm $(npm --version 2>/dev/null)"
else
  fail "npm not found. Install Node.js: https://nodejs.org"
fi

# claude (optional but recommended)
if command -v claude >/dev/null 2>&1; then
  info "claude $(claude --version 2>/dev/null | head -1)"
else
  warn "claude not found — install Claude Code to use the bridge"
  warn "  npm i -g @anthropic-ai/claude-code"
fi

# --- Install -----------------------------------------------------------------

echo ""
echo "${BOLD}Installing a2a-bridge...${RESET}"

npm i -g a2a-bridge 2>&1 | tail -3

if ! command -v a2a-bridge >/dev/null 2>&1; then
  # npm global bin might not be on PATH
  NPM_BIN=$(npm config get prefix)/bin
  if [ -x "$NPM_BIN/a2a-bridge" ]; then
    warn "a2a-bridge installed at $NPM_BIN but not on PATH"
    warn "  Add to your shell profile: export PATH=\"$NPM_BIN:\$PATH\""
    export PATH="$NPM_BIN:$PATH"
  else
    fail "a2a-bridge install failed"
  fi
fi

info "a2a-bridge $(a2a-bridge --version 2>/dev/null)"

# --- Configure ---------------------------------------------------------------

echo ""
echo "${BOLD}Configuring...${RESET}"

a2a-bridge init --print 2>&1 | while IFS= read -r line; do
  echo "  $line"
done

# --- Done --------------------------------------------------------------------

echo ""
echo "${BOLD}${GREEN}Done!${RESET} Next steps:"
echo ""
echo "  ${BOLD}Start the bridge:${RESET}"
echo "    a2a-bridge claude              # interactive Claude Code with bridge"
echo ""
echo "  ${BOLD}Or headless (tmux):${RESET}"
echo "    a2a-bridge daemon start"
echo "    tmux new-session -d -s cc-bridge \"a2a-bridge claude\""
echo "    tmux send-keys -t cc-bridge Enter"
echo ""
echo "  ${BOLD}On the client (OpenClaw / Hermes Agent):${RESET}"
echo "    Tell the agent:"
echo "    Read https://raw.githubusercontent.com/firstintent/a2a-bridge/main/docs/join.md and follow it."
echo ""
