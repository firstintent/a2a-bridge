#!/usr/bin/env bun
/**
 * ACP half of the end-to-end smoke test (P6.8, updated for P8.4).
 *
 * Spawns `bun run src/cli/cli.ts acp` as a child process and drives it
 * with the ACP SDK's `ClientSideConnection` over the child's stdio.
 *
 * As of P8.4 the subcommand always relays every turn through the
 * daemon's control plane — there is no in-process echo fallback.  To
 * keep this smoke self-contained (no real Claude Code session
 * required) the script boots a small WebSocket listener that plays the
 * role of "daemon control plane": it answers every `acp_turn_start`
 * with a deterministic `acp_turn_chunk` + `acp_turn_complete` pair.
 * The subprocess's DaemonProxyGateway is pointed at this fake daemon
 * via `A2A_BRIDGE_CONTROL_PORT`.
 *
 * Assertions:
 *   - `initialize` resolves with `protocolVersion` + agent info
 *   - `session/new` returns a non-empty `sessionId`
 *   - `session/prompt` streams at least one `session/update` and
 *     resolves with `stopReason: "end_turn"`
 *   - the observed chunk text starts with `smoke-daemon:` (the fake
 *     daemon's prefix), NOT `Echo:` — regressions that reinstate the
 *     old echo gateway fail this check.
 *
 * Exits non-zero on the first failed expectation.
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { WebSocketListener } from "../src/transport/websocket";
import type { Connection } from "../src/transport/listener";
import type {
  ControlClientMessage,
  ControlServerMessage,
} from "../src/transport/control-protocol";

interface CapturedUpdate {
  sessionId: string;
  kind: string;
  text?: string;
}

function fail(msg: string): never {
  console.error(`[acp] FAIL: ${msg}`);
  process.exit(1);
}

// Pick an ephemeral port that won't collide with the outer daemon.
const FAKE_DAEMON_PORT = 14800 + Math.floor(Math.random() * 100);
const fakeDaemon = new WebSocketListener({ port: FAKE_DAEMON_PORT, path: "/ws" });
fakeDaemon.on("connection", (conn: Connection) => {
  conn.on("message", (raw: string) => {
    let frame: ControlClientMessage;
    try {
      frame = JSON.parse(raw) as ControlClientMessage;
    } catch {
      return;
    }
    if (frame.type !== "acp_turn_start") return;
    const chunk: ControlServerMessage = {
      type: "acp_turn_chunk",
      turnId: frame.turnId,
      text: `smoke-daemon: ${frame.userText}`,
    };
    conn.send(JSON.stringify(chunk));
    const done: ControlServerMessage = {
      type: "acp_turn_complete",
      turnId: frame.turnId,
    };
    conn.send(JSON.stringify(done));
  });
});
await fakeDaemon.listen();

const child = spawn("bun", ["run", "src/cli/cli.ts", "acp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    A2A_BRIDGE_ACP_SKIP_DAEMON: "1",
    A2A_BRIDGE_CONTROL_PORT: String(FAKE_DAEMON_PORT),
  },
});

child.on("error", (err) => fail(`spawn error: ${err.message}`));

const exitTimer = setTimeout(() => {
  console.error("[acp] FAIL: timed out after 30s");
  child.kill("SIGKILL");
  process.exit(1);
}, 30_000);

try {
  const input = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const output: WritableStream<Uint8Array> = new WritableStream<Uint8Array>({
    write(chunk) {
      child.stdin!.write(chunk);
    },
    close() {
      child.stdin!.end();
    },
  });

  const updates: CapturedUpdate[] = [];
  const recordingClient = {
    async sessionUpdate(params: {
      sessionId: string;
      update: { sessionUpdate: string; content?: { type: string; text: string } };
    }): Promise<void> {
      updates.push({
        sessionId: params.sessionId,
        kind: params.update.sessionUpdate,
        text:
          params.update.content?.type === "text"
            ? params.update.content.text
            : undefined,
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
      recordingClient as unknown as ConstructorParameters<
        typeof ClientSideConnection
      >[0] extends (c: unknown) => infer R
        ? R
        : never,
    ndJsonStream(output, input),
  );

  const init = await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  if (init.protocolVersion !== PROTOCOL_VERSION)
    fail(`protocol mismatch (got ${init.protocolVersion})`);
  if (init.agentInfo?.name !== "a2a-bridge")
    fail(`unexpected agent name: ${init.agentInfo?.name}`);
  console.log(`[acp] initialize OK (protocol v${init.protocolVersion})`);

  const session = await client.newSession({
    cwd: "/tmp/acp-smoke-e2e",
    mcpServers: [],
  });
  if (!session.sessionId || session.sessionId.length === 0)
    fail("session/new returned empty sessionId");
  console.log(`[acp] session ${session.sessionId}`);

  const resp = await client.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "smoke-e2e" }],
  });
  if (resp.stopReason !== "end_turn")
    fail(`expected stopReason=end_turn, got ${resp.stopReason}`);

  // Let the final session/update notification flush through ndJsonStream
  // before we inspect it.
  await new Promise((r) => setImmediate(r));
  const chunks = updates.filter(
    (u) => u.kind === "agent_message_chunk" && u.sessionId === session.sessionId,
  );
  if (chunks.length === 0) fail("no agent_message_chunk updates observed");

  const fromDaemon = chunks.find((c) => c.text?.startsWith("smoke-daemon:"));
  if (!fromDaemon) fail(`expected a daemon-originated chunk, got: ${JSON.stringify(chunks)}`);
  const echoed = chunks.find((c) => c.text?.startsWith("Echo:"));
  if (echoed) fail(`echo-gateway regression: saw ${echoed.text}`);

  console.log(
    `[acp] prompt OK (stopReason=${resp.stopReason}, ${chunks.length} update(s) incl. "${fromDaemon.text}")`,
  );
} finally {
  clearTimeout(exitTimer);
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  if (!child.killed) child.kill("SIGKILL");
  await fakeDaemon.close();
}
