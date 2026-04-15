/**
 * P10.6 — Attach conflict policy integration test.
 *
 * Boots the real daemon, then attaches two CCs to the same TargetId
 * via the plugin-side `DaemonClient` seam and asserts:
 *
 *   1. Without `force`, the second attach receives
 *      `claude_connect_rejected` (→ `connectRejected` event) and the
 *      first attach stays owner.
 *   2. With `force=true`, the second attach takes over; the first
 *      receives `claude_connect_replaced` and its socket is closed.
 *
 * These are the core wire-level guarantees of P10.6. Unit tests at
 * the DaemonClient layer (daemon-client.test.ts) cover the reverse
 * direction (events fire on incoming frames); this test exercises
 * the daemon's actual decision logic end-to-end.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@plugin/daemon-client/daemon-client";
import type { TargetEntry } from "@transport/control-protocol";

/**
 * Fire a one-shot `list_targets` RPC and return the snapshot, so the
 * test can assert what `a2a-bridge daemon targets` would print.
 */
async function listTargetsRpc(controlWsUrl: string): Promise<TargetEntry[]> {
  return new Promise<TargetEntry[]>((resolve, reject) => {
    const requestId = `t_${Math.floor(Math.random() * 1e9)}`;
    const ws = new WebSocket(controlWsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("timed out waiting for targets_response"));
    }, 4000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "list_targets", requestId }));
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : ev.data.toString();
      try {
        const m = JSON.parse(raw);
        if (m.type === "targets_response" && m.requestId === requestId) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(m.targets as TargetEntry[]);
        }
      } catch {}
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
}

const DAEMON_SRC = fileURLToPath(
  new URL("../runtime-daemon/daemon.ts", import.meta.url),
);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {}
  }
});
function register(fn: () => Promise<void> | void) {
  cleanups.push(fn);
}

function pickPorts(count: number): number[] {
  const base = 16800 + Math.floor(Math.random() * 300);
  return Array.from({ length: count }, (_, i) => base + i);
}

async function waitForHealthz(port: number, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not become healthy on port ${port} within ${timeoutMs}ms`);
}

async function startDaemon(opts: {
  stateDir: string;
  controlPort: number;
  codexWsPort: number;
  codexProxyPort: number;
}): Promise<ChildProcess> {
  const proc = spawn("bun", ["run", DAEMON_SRC], {
    env: {
      ...process.env,
      A2A_BRIDGE_STATE_DIR: opts.stateDir,
      A2A_BRIDGE_CONTROL_PORT: String(opts.controlPort),
      CODEX_WS_PORT: String(opts.codexWsPort),
      CODEX_PROXY_PORT: String(opts.codexProxyPort),
      A2A_BRIDGE_BEARER_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  register(async () => {
    if (!proc.killed) proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    if (!proc.killed) proc.kill("SIGKILL");
  });
  await waitForHealthz(opts.controlPort);
  return proc;
}

describe("P10.6 attach conflict policy", () => {
  test("second attach without force is rejected; first stays owner", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "a2a-bridge-p10-6-reject-"));
    register(() => rmSync(stateDir, { recursive: true, force: true }));

    const [controlPort, codexWsPort, codexProxyPort] = pickPorts(3);
    await startDaemon({
      stateDir,
      controlPort: controlPort!,
      codexWsPort: codexWsPort!,
      codexProxyPort: codexProxyPort!,
    });

    const TARGET = "claude:ws-a";
    const ctrlUrl = `ws://127.0.0.1:${controlPort}/ws`;

    const first = new DaemonClient(ctrlUrl);
    await first.connect();
    register(() => first.disconnect());
    first.attachClaude(TARGET);

    // Give the daemon a beat to install the first attach before the
    // second arrives — otherwise the two `claude_connect` frames race
    // and whichever lands first becomes "first".
    await new Promise((r) => setTimeout(r, 80));

    const second = new DaemonClient(ctrlUrl);
    await second.connect();
    register(() => second.disconnect());

    const rejection = new Promise<{ target: string; reason: string }>((resolve) => {
      second.on("connectRejected", resolve);
    });
    // First must NOT receive a replaced event — count events for a
    // grace window and assert zero.
    let firstReplacedCount = 0;
    first.on("connectReplaced", () => {
      firstReplacedCount += 1;
    });

    second.attachClaude(TARGET);

    const ev = await rejection;
    expect(ev.target).toBe(TARGET);
    expect(ev.reason).toMatch(/already attached/i);
    expect(firstReplacedCount).toBe(0);
  }, 20_000);

  test("daemon targets does not advertise a phantom claude:default row when all attaches are explicit targets", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "a2a-bridge-p10-6-noghost-"));
    register(() => rmSync(stateDir, { recursive: true, force: true }));

    const [controlPort, codexWsPort, codexProxyPort] = pickPorts(3);
    await startDaemon({
      stateDir,
      controlPort: controlPort!,
      codexWsPort: codexWsPort!,
      codexProxyPort: codexProxyPort!,
    });

    const ctrlUrl = `ws://127.0.0.1:${controlPort}/ws`;
    const a = new DaemonClient(ctrlUrl);
    await a.connect();
    register(() => a.disconnect());
    a.attachClaude("claude:proj-a");
    const b = new DaemonClient(ctrlUrl);
    await b.connect();
    register(() => b.disconnect());
    b.attachClaude("claude:proj-b");
    await new Promise((r) => setTimeout(r, 120));

    // Query the daemon's `list_targets` RPC directly so we can assert
    // the snapshot the CLI would print — no phantom `claude:default`
    // row, just the two explicit attaches.
    const targets = await listTargetsRpc(ctrlUrl);
    const names = targets.map((t) => t.target).sort();
    expect(names).toEqual(["claude:proj-a", "claude:proj-b"]);
  }, 20_000);

  test("second attach with force=true replaces the first", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "a2a-bridge-p10-6-force-"));
    register(() => rmSync(stateDir, { recursive: true, force: true }));

    const [controlPort, codexWsPort, codexProxyPort] = pickPorts(3);
    await startDaemon({
      stateDir,
      controlPort: controlPort!,
      codexWsPort: codexWsPort!,
      codexProxyPort: codexProxyPort!,
    });

    const TARGET = "claude:ws-b";
    const ctrlUrl = `ws://127.0.0.1:${controlPort}/ws`;

    const first = new DaemonClient(ctrlUrl);
    await first.connect();
    register(() => first.disconnect());
    first.attachClaude(TARGET);

    const replaced = new Promise<{ target: string }>((resolve) => {
      first.on("connectReplaced", resolve);
    });
    const firstDisconnected = new Promise<void>((resolve) => {
      first.on("disconnect", () => resolve());
    });

    await new Promise((r) => setTimeout(r, 80));

    const second = new DaemonClient(ctrlUrl);
    await second.connect();
    register(() => second.disconnect());
    let secondRejected = false;
    second.on("connectRejected", () => {
      secondRejected = true;
    });
    second.attachClaude(TARGET, true);

    const ev = await replaced;
    expect(ev.target).toBe(TARGET);
    await firstDisconnected;
    expect(secondRejected).toBe(false);
  }, 20_000);
});
