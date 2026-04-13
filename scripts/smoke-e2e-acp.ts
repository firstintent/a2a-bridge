#!/usr/bin/env bun
/**
 * ACP half of the end-to-end smoke test (P6.8).
 *
 * Spawns `bun run src/cli/cli.ts acp` as a child process, drives it
 * with the ACP SDK's `ClientSideConnection` over the child's stdio,
 * and asserts:
 *
 *   - `initialize` resolves with `protocolVersion` + agent info
 *   - `session/new` returns a non-empty `sessionId`
 *   - `session/prompt` streams at least one `session/update` and
 *     resolves with `stopReason: "end_turn"` (v0.1 echo gateway)
 *
 * Exits non-zero on the first failed expectation. The caller
 * (`scripts/smoke-e2e.sh`) is responsible for passing a unique
 * `A2A_BRIDGE_CONTROL_PORT` / `A2A_BRIDGE_STATE_DIR` so we don't
 * collide with any production daemon the user already has running.
 */

import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

interface CapturedUpdate {
  sessionId: string;
  kind: string;
  text?: string;
}

function fail(msg: string): never {
  console.error(`[acp] FAIL: ${msg}`);
  process.exit(1);
}

const child = spawn("bun", ["run", "src/cli/cli.ts", "acp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, A2A_BRIDGE_ACP_SKIP_DAEMON: "1" },
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
  // before we count it.
  await new Promise((r) => setImmediate(r));
  const chunks = updates.filter(
    (u) => u.kind === "agent_message_chunk" && u.sessionId === session.sessionId,
  );
  if (chunks.length === 0) fail("no agent_message_chunk updates observed");
  console.log(
    `[acp] prompt OK (stopReason=${resp.stopReason}, ${chunks.length} update(s))`,
  );
} finally {
  clearTimeout(exitTimer);
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  if (!child.killed) child.kill("SIGKILL");
}
