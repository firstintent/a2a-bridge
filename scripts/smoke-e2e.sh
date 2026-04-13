#!/usr/bin/env bash
# smoke-e2e.sh — end-to-end A2A + ACP wire-level smoke test (P6.8).
#
# A2A half: start the daemon with `A2A_BRIDGE_INBOUND_ECHO=1` so the
# inbound executor is the built-in echo (no Claude Code attach needed),
# POST a `message/stream`, and assert the four-event SSE envelope.
# ACP half: invoke `scripts/smoke-e2e-acp.ts`, which spawns
# `a2a-bridge acp` and drives it with the ACP SDK's
# `ClientSideConnection` to assert initialize → session/new → prompt
# → one streamed update + terminal `end_turn`.
#
# All state — state-dir, ports, daemon log — lives under a throwaway
# `mktemp -d` path; the daemon is killed on exit even when a step
# fails. No production state-dir, plugin, or port is touched.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/a2a-bridge-e2e.XXXXXX")

# Ports picked from the ephemeral range to avoid collisions with any
# production daemon the user may already have running.
SMOKE_A2A_PORT=${SMOKE_A2A_PORT:-14520}
SMOKE_CONTROL_PORT=${SMOKE_CONTROL_PORT:-14512}
SMOKE_CODEX_WS=${SMOKE_CODEX_WS:-14525}
SMOKE_CODEX_PROXY=${SMOKE_CODEX_PROXY:-14526}
SMOKE_TOKEN="smoke-$(date +%s)-$$"

export A2A_BRIDGE_STATE_DIR="$WORK/state"
export A2A_BRIDGE_BEARER_TOKEN="$SMOKE_TOKEN"
export A2A_BRIDGE_INBOUND_ECHO=1
export A2A_BRIDGE_A2A_PORT="$SMOKE_A2A_PORT"
export A2A_BRIDGE_CONTROL_PORT="$SMOKE_CONTROL_PORT"
export CODEX_WS_PORT="$SMOKE_CODEX_WS"
export CODEX_PROXY_PORT="$SMOKE_CODEX_PROXY"
mkdir -p "$A2A_BRIDGE_STATE_DIR"

# Loopback talk must never transit an HTTP proxy; some dev machines
# export `http_proxy` globally and misconfigure `no_proxy` so 127.*
# still routes through the proxy and returns 502.
CURL=(curl --noproxy '127.0.0.1,localhost')

DAEMON_PID=""
cleanup() {
  if [ -n "$DAEMON_PID" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "[e2e] starting daemon in echo mode..."
bun run src/runtime-daemon/daemon.ts >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!

# Wait for /healthz on the inbound port (up to ~5s).
ready=0
for _ in $(seq 1 50); do
  if "${CURL[@]}" -sf "http://127.0.0.1:$SMOKE_A2A_PORT/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "[e2e] FAIL: daemon did not respond on /healthz within 5s"
  echo "--- daemon.log tail ---"
  tail -n 40 "$WORK/daemon.log"
  exit 1
fi

echo "[e2e] posting A2A message/stream..."
SSE=$("${CURL[@]}" -sN "http://127.0.0.1:$SMOKE_A2A_PORT/a2a" \
  -H "Authorization: Bearer $A2A_BRIDGE_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"message/stream","params":{"message":{"parts":[{"kind":"text","text":"smoke"}]}},"id":"e2e-1"}')

DATA_LINES=$(printf '%s\n' "$SSE" | grep -c '^data: ' || true)
if [ "$DATA_LINES" -lt 4 ]; then
  echo "[e2e] FAIL: expected >=4 SSE frames, got $DATA_LINES"
  echo "--- sse ---"
  printf '%s\n' "$SSE"
  exit 1
fi
if ! printf '%s\n' "$SSE" | grep -q '"state":"completed"'; then
  echo "[e2e] FAIL: no completed status-update in SSE stream"
  printf '%s\n' "$SSE"
  exit 1
fi
if ! printf '%s\n' "$SSE" | grep -q '"final":true'; then
  echo "[e2e] FAIL: no final-flag status-update in SSE stream"
  exit 1
fi
echo "[e2e] A2A envelope OK ($DATA_LINES frames, completed/final present)"

# Keep the daemon alive across the ACP half so `a2a-bridge acp`'s
# built-in `ensureRunning` probe finds an already-live daemon at
# control port $SMOKE_CONTROL_PORT and resolves immediately (the
# smoke doesn't depend on ACP driving the daemon — the v0.1 echo
# gateway is in-process — but the probe would otherwise spend
# seconds launching its own).
echo "[e2e] driving ACP subprocess..."
bun scripts/smoke-e2e-acp.ts

echo "[e2e] OK"
