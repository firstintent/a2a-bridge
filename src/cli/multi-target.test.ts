/**
 * P10.10 — Cross-target integration test.
 *
 * Boots a real daemon, attaches two stub CCs as `claude:ws-a` and
 * `claude:ws-b`, then drives two concurrent ACP subprocesses with
 * distinct `--target` values. Each subprocess sends a unique prompt;
 * the assertion is that each subprocess's reply carries ONLY the
 * matching CC's tagged echo — proving the inbound ACP → CC → reply
 * path is target-isolated (no cross-talk between rooms).
 *
 * Covers the end-to-end wire for multi-claude routing introduced
 * across P10.1–P10.8:
 *  - P10.2 claude_connect.target
 *  - P10.4 acp_turn_start.target
 *  - P10.10 per-target DaemonClaudeCodeGateway so inbound text lands
 *    on the correct attached CC, and per-target interceptReply so
 *    each CC's reply closes its own room's in-flight turn.
 *
 * Scope note: codex peer-id routing is deferred to v0.3 (see P10.9).
 * This test covers the multi-claude axis only.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { DaemonClient } from "@plugin/daemon-client/daemon-client";
import type { BridgeMessage } from "@messages/types";

interface CapturedUpdate {
  sessionId: string;
  kind: string;
  text?: string;
}

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
  const base = 17800 + Math.floor(Math.random() * 300);
  return Array.from({ length: count }, (_, i) => base + i);
}

const DAEMON_SRC = fileURLToPath(
  new URL("../runtime-daemon/daemon.ts", import.meta.url),
);
const CLI_SRC = fileURLToPath(new URL("./cli.ts", import.meta.url));

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

/** Spawn an `a2a-bridge acp` subprocess for one target. */
function spawnAcp(stateDir: string, controlPort: number, target: string): ChildProcess {
  const proc = spawn("bun", ["run", CLI_SRC, "acp", "--target", target], {
    env: {
      ...process.env,
      A2A_BRIDGE_STATE_DIR: stateDir,
      A2A_BRIDGE_CONTROL_PORT: String(controlPort),
      A2A_BRIDGE_ACP_SKIP_DAEMON: "1",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  register(async () => {
    if (!proc.killed) proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    if (!proc.killed) proc.kill("SIGKILL");
  });
  return proc;
}

/** Wrap the subprocess's stdio in an ACP `ClientSideConnection`. */
function clientForAcp(proc: ChildProcess): {
  client: ClientSideConnection;
  updates: CapturedUpdate[];
} {
  const updates: CapturedUpdate[] = [];
  const input = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
  const output: WritableStream<Uint8Array> = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin!.write(chunk);
    },
    close() {
      proc.stdin!.end();
    },
  });
  const recording = {
    async sessionUpdate(params: {
      sessionId: string;
      update: { sessionUpdate: string; content?: { type: string; text: string } };
    }): Promise<void> {
      updates.push({
        sessionId: params.sessionId,
        kind: params.update.sessionUpdate,
        text:
          params.update.content?.type === "text" ? params.update.content.text : undefined,
      });
    },
    async requestPermission(): Promise<never> {
      throw new Error("unexpected requestPermission");
    },
    async readTextFile(): Promise<never> {
      throw new Error("unexpected readTextFile");
    },
    async writeTextFile(): Promise<never> {
      throw new Error("unexpected writeTextFile");
    },
  };
  const client = new ClientSideConnection(
    () =>
      recording as unknown as ConstructorParameters<
        typeof ClientSideConnection
      >[0] extends (c: unknown) => infer R
        ? R
        : never,
    ndJsonStream(output, input),
  );
  return { client, updates };
}

describe("P10.10 cross-target integration", () => {
  test("two ACP turns on distinct targets don't cross-talk", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "a2a-bridge-p10-10-"));
    register(() => rmSync(stateDir, { recursive: true, force: true }));

    const [controlPort, codexWsPort, codexProxyPort] = pickPorts(3);
    await startDaemon({
      stateDir,
      controlPort: controlPort!,
      codexWsPort: codexWsPort!,
      codexProxyPort: codexProxyPort!,
    });

    // Attach two stub CCs. Each echoes incoming text back to the
    // daemon with a target-specific prefix, so we can tell CC-A's
    // reply from CC-B's on the wire.
    const ctrlUrl = `ws://127.0.0.1:${controlPort}/ws`;
    const PREFIX_A = "CC-A:";
    const PREFIX_B = "CC-B:";

    const ccA = new DaemonClient(ctrlUrl);
    await ccA.connect();
    register(() => ccA.disconnect());
    ccA.attachClaude("claude:ws-a");
    ccA.on("codexMessage", (msg: BridgeMessage) => {
      const reply: BridgeMessage = {
        id: `a-${Date.now()}`,
        source: "claude",
        content: `${PREFIX_A} ${msg.content}`,
        timestamp: Date.now(),
      };
      void ccA.sendReply(reply);
    });

    const ccB = new DaemonClient(ctrlUrl);
    await ccB.connect();
    register(() => ccB.disconnect());
    ccB.attachClaude("claude:ws-b");
    ccB.on("codexMessage", (msg: BridgeMessage) => {
      const reply: BridgeMessage = {
        id: `b-${Date.now()}`,
        source: "claude",
        content: `${PREFIX_B} ${msg.content}`,
        timestamp: Date.now(),
      };
      void ccB.sendReply(reply);
    });

    // Let both attaches settle before starting ACP work.
    await new Promise((r) => setTimeout(r, 100));

    const acpA = spawnAcp(stateDir, controlPort!, "claude:ws-a");
    const acpB = spawnAcp(stateDir, controlPort!, "claude:ws-b");

    const { client: clientA, updates: updatesA } = clientForAcp(acpA);
    const { client: clientB, updates: updatesB } = clientForAcp(acpB);

    // Initialise both subprocesses concurrently.
    await Promise.all([
      clientA.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      clientB.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
    ]);
    const [sessionA, sessionB] = await Promise.all([
      clientA.newSession({ cwd: "/tmp/p10-10-a", mcpServers: [] }),
      clientB.newSession({ cwd: "/tmp/p10-10-b", mcpServers: [] }),
    ]);

    const USER_TEXT_A = "hello from acp-a";
    const USER_TEXT_B = "hello from acp-b";

    const [respA, respB] = await Promise.all([
      clientA.prompt({
        sessionId: sessionA.sessionId,
        prompt: [{ type: "text", text: USER_TEXT_A }],
      }),
      clientB.prompt({
        sessionId: sessionB.sessionId,
        prompt: [{ type: "text", text: USER_TEXT_B }],
      }),
    ]);
    expect(respA.stopReason).toBe("end_turn");
    expect(respB.stopReason).toBe("end_turn");

    await new Promise((r) => setImmediate(r));

    // Subprocess A must ONLY see CC-A's prefix; subprocess B, ONLY
    // CC-B's. Cross-contamination would show up as the other prefix
    // appearing in the wrong subprocess's update stream.
    const chunksA = updatesA
      .filter((u) => u.kind === "agent_message_chunk")
      .map((u) => u.text ?? "");
    const chunksB = updatesB
      .filter((u) => u.kind === "agent_message_chunk")
      .map((u) => u.text ?? "");

    expect(chunksA.some((t) => t.startsWith(PREFIX_A))).toBe(true);
    expect(chunksA.some((t) => t.startsWith(PREFIX_B))).toBe(false);

    expect(chunksB.some((t) => t.startsWith(PREFIX_B))).toBe(true);
    expect(chunksB.some((t) => t.startsWith(PREFIX_A))).toBe(false);

    // Nothing should have fallen through to an echo executor — that
    // would mean the router didn't see the attached CC.
    expect(chunksA.some((t) => t.startsWith("Echo:"))).toBe(false);
    expect(chunksB.some((t) => t.startsWith("Echo:"))).toBe(false);
  }, 45_000);
});
