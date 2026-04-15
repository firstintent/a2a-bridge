/**
 * P10.8 — `reply` tool target routing integration test.
 *
 * Boots a real daemon, attaches two stub CCs (`claude:ws-a`,
 * `claude:ws-b`), and verifies every branch of the new outbound
 * routing via the control-plane `claude_to_codex` frame:
 *
 *   - **forward**: CC-a sends a reply with `target="claude:ws-b"`;
 *     CC-b receives it as `codex_to_claude`; the sender sees a
 *     successful `claude_to_codex_result`.
 *   - **unknown target**: CC-a sends with a non-attached target;
 *     daemon returns `success: false` with a descriptive error.
 *   - **omit target**: CC-a sends with no target and no Codex/ACP
 *     inbound turn in flight; daemon returns the v0.1 "Codex not
 *     ready" error — proving the absent-target path is unchanged.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@plugin/daemon-client/daemon-client";
import type { BridgeMessage } from "@messages/types";

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
  const base = 17200 + Math.floor(Math.random() * 300);
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

describe("P10.8 reply tool target routing", () => {
  test("forward / unknown / omit paths all behave correctly", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "a2a-bridge-p10-8-"));
    register(() => rmSync(stateDir, { recursive: true, force: true }));

    const [controlPort, codexWsPort, codexProxyPort] = pickPorts(3);
    await startDaemon({
      stateDir,
      controlPort: controlPort!,
      codexWsPort: codexWsPort!,
      codexProxyPort: codexProxyPort!,
    });

    const ctrlUrl = `ws://127.0.0.1:${controlPort}/ws`;

    // Attach two stub CCs under distinct TargetIds.
    const ccA = new DaemonClient(ctrlUrl);
    await ccA.connect();
    register(() => ccA.disconnect());
    ccA.attachClaude("claude:ws-a");

    const ccB = new DaemonClient(ctrlUrl);
    await ccB.connect();
    register(() => ccB.disconnect());
    ccB.attachClaude("claude:ws-b");

    // Give the daemon time to register both attaches before we start
    // exercising routes — otherwise the first sendReply could land
    // before `attachedClaudeByTarget` has the destination entry.
    await new Promise((r) => setTimeout(r, 100));

    // Buffer every codex_to_claude frame CC-b receives so we can
    // assert post-hoc that exactly the right one arrived.
    const bInbox: BridgeMessage[] = [];
    ccB.on("codexMessage", (m) => bInbox.push(m));

    // --- 1) forward: CC-a targets CC-b directly. ---------------------
    const forwardResult = await ccA.sendReply(
      {
        id: "fwd-1",
        source: "claude",
        content: "hello from ws-a",
        timestamp: Date.now(),
      },
      false,
      "claude:ws-b",
    );
    expect(forwardResult.success).toBe(true);
    expect(forwardResult.error).toBeUndefined();
    // Allow the asynchronous delivery to CC-b to land.
    await new Promise((r) => setTimeout(r, 60));
    const forwarded = bInbox.find((m) => m.content === "hello from ws-a");
    expect(forwarded).toBeDefined();
    expect(forwarded?.source).toBe("claude");

    // --- 2) unknown target: daemon must reject gracefully. -----------
    const unknownResult = await ccA.sendReply(
      {
        id: "unk-1",
        source: "claude",
        content: "should not arrive anywhere",
        timestamp: Date.now(),
      },
      false,
      "claude:ws-nonexistent",
    );
    expect(unknownResult.success).toBe(false);
    expect(unknownResult.error ?? "").toMatch(/not attached/i);

    // --- 3) omit target: preserves v0.1 behaviour. -------------------
    // With no Codex TUI, the daemon's "Codex not ready" branch is the
    // one observable proof that we took the legacy path.
    const omitResult = await ccA.sendReply(
      {
        id: "omit-1",
        source: "claude",
        content: "no target — should fall through",
        timestamp: Date.now(),
      },
      false,
    );
    expect(omitResult.success).toBe(false);
    expect(omitResult.error ?? "").toMatch(/codex is not ready/i);
  }, 25_000);

  test("invalid TargetId shape is rejected before any routing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "a2a-bridge-p10-8-bad-"));
    register(() => rmSync(stateDir, { recursive: true, force: true }));

    const [controlPort, codexWsPort, codexProxyPort] = pickPorts(3);
    await startDaemon({
      stateDir,
      controlPort: controlPort!,
      codexWsPort: codexWsPort!,
      codexProxyPort: codexProxyPort!,
    });

    const ccA = new DaemonClient(`ws://127.0.0.1:${controlPort}/ws`);
    await ccA.connect();
    register(() => ccA.disconnect());
    ccA.attachClaude("claude:ws-a");
    await new Promise((r) => setTimeout(r, 80));

    const res = await ccA.sendReply(
      {
        id: "bad-1",
        source: "claude",
        content: "x",
        timestamp: Date.now(),
      },
      false,
      "NotAValidTarget",
    );
    expect(res.success).toBe(false);
    expect(res.error ?? "").toMatch(/invalid target/i);
  }, 20_000);
});
