#!/usr/bin/env bun
/**
 * ACP half of the end-to-end smoke test (P8.6).
 *
 * Assumes `scripts/smoke-e2e.sh` already launched the real daemon at
 * `A2A_BRIDGE_CONTROL_PORT` (without `A2A_BRIDGE_INBOUND_ECHO=1` —
 * that hook is kept in the codebase as a debug knob but is NOT used
 * here).
 *
 * Flow:
 *   1. Attach a stub CC client to the live daemon via the plugin-side
 *      `DaemonClient` seam.  The stub replies to every inbound
 *      `codex_to_claude` frame with a deterministic `smoke-cc:` prefix.
 *   2. Spawn `bun run src/cli/cli.ts acp` as a child, pointing at the
 *      same daemon.  The subprocess connects via DaemonProxyGateway.
 *   3. Drive the ACP SDK's `ClientSideConnection` against the child's
 *      stdio and assert the response chunk text starts with the stub
 *      CC's prefix — a regression that falls back to the echo gateway
 *      (or any other shortcut) fails this check.
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
import { DaemonClient } from "../src/runtime-plugin/daemon-client/daemon-client";
import type { BridgeMessage } from "../src/messages/types";

interface CapturedUpdate {
  sessionId: string;
  kind: string;
  text?: string;
}

function fail(msg: string): never {
  console.error(`[acp] FAIL: ${msg}`);
  process.exit(1);
}

const CONTROL_PORT = parseInt(
  process.env.A2A_BRIDGE_CONTROL_PORT ?? "4512",
  10,
);
const STUB_PREFIX = "smoke-cc:";

// 1. Attach the stub CC to the running daemon.
const stubCc = new DaemonClient(`ws://127.0.0.1:${CONTROL_PORT}/ws`);
try {
  await stubCc.connect();
} catch (err) {
  fail(`stub CC failed to connect to daemon on port ${CONTROL_PORT}: ${(err as Error).message}`);
}
stubCc.attachClaude();

stubCc.on("codexMessage", (msg: BridgeMessage) => {
  const reply: BridgeMessage = {
    id: `stub-${Date.now()}`,
    source: "claude",
    content: `${STUB_PREFIX} ${msg.content}`,
    timestamp: Date.now(),
  };
  void stubCc.sendReply(reply).catch(() => {});
});

// 2. Spawn the ACP subprocess pointed at the same daemon.
const child = spawn("bun", ["run", "src/cli/cli.ts", "acp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    A2A_BRIDGE_ACP_SKIP_DAEMON: "1",
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

  await new Promise((r) => setImmediate(r));
  const chunks = updates.filter(
    (u) => u.kind === "agent_message_chunk" && u.sessionId === session.sessionId,
  );
  if (chunks.length === 0) fail("no agent_message_chunk updates observed");

  const fromStub = chunks.find((c) => c.text?.startsWith(STUB_PREFIX));
  if (!fromStub) fail(`expected a stub-cc chunk, got: ${JSON.stringify(chunks)}`);
  const echoed = chunks.find((c) => c.text?.startsWith("Echo:"));
  if (echoed) fail(`echo-gateway regression: saw ${echoed.text}`);

  console.log(
    `[acp] prompt OK (stopReason=${resp.stopReason}, ${chunks.length} update(s) incl. "${fromStub.text}")`,
  );
} finally {
  clearTimeout(exitTimer);
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  if (!child.killed) child.kill("SIGKILL");
  await stubCc.disconnect();
}
