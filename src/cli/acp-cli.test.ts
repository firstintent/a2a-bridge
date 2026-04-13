import { describe, test, expect, afterEach } from "bun:test";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { runAcp } from "./acp";
import { DaemonUnreachableError } from "./errors";
import { WebSocketListener } from "@transport/websocket";
import type { Connection } from "@transport/listener";
import type {
  ControlClientMessage,
  ControlServerMessage,
} from "@transport/control-protocol";

/**
 * E2E: `a2a-bridge acp` CLI round-trip against a fake daemon (P8.4).
 *
 * These tests exercise the production code path that lands after P8.4:
 * `runAcp` constructs a `DaemonProxyGateway`, sends each ACP `prompt`
 * through the daemon control plane, and streams chunks back.  The
 * fake daemon replies with a deterministic "daemon:" prefix so the
 * assertion makes the contrast with the old EchoGateway explicit —
 * a regression that silently falls back to echo would print "Echo:"
 * and the test would fail.
 *
 * Filtered out of `test:unit` by the `E2E:` prefix — CI executes them
 * under `check:ci` alongside the rest of the E2E matrix.
 */

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

function randomPort(): number {
  return 49000 + Math.floor(Math.random() * 1000);
}

/**
 * Fake daemon that replies to every `acp_turn_start` with one chunk
 * echoing the text back with a `daemon:` prefix, then `acp_turn_complete`.
 * The prefix makes the reply provenance observable — an echo-gateway
 * regression would produce `Echo:` instead.
 */
async function bootFakeDaemon(port: number): Promise<void> {
  const listener = new WebSocketListener({ port, path: "/ws" });
  register(() => listener.close());

  listener.on("connection", (conn: Connection) => {
    conn.on("message", (raw: string) => {
      let frame: ControlClientMessage;
      try {
        frame = JSON.parse(raw) as ControlClientMessage;
      } catch {
        return;
      }
      if (frame.type !== "acp_turn_start") return;
      const reply: ControlServerMessage = {
        type: "acp_turn_chunk",
        turnId: frame.turnId,
        text: `daemon: ${frame.userText}`,
      };
      conn.send(JSON.stringify(reply));
      const done: ControlServerMessage = {
        type: "acp_turn_complete",
        turnId: frame.turnId,
      };
      conn.send(JSON.stringify(done));
    });
  });
  await listener.listen();
}

function makeRecordingClient(updates: CapturedUpdate[]) {
  return {
    async sessionUpdate(params: {
      sessionId: string;
      update: { sessionUpdate: string; content?: { type: string; text: string } };
    }): Promise<void> {
      const text =
        params.update.content?.type === "text"
          ? params.update.content.text
          : undefined;
      updates.push({
        sessionId: params.sessionId,
        kind: params.update.sessionUpdate,
        text,
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
}

describe("E2E: a2a-bridge acp CLI subcommand", () => {
  test("prompt returns a daemon-originated reply, not an echo", async () => {
    const port = randomPort();
    await bootFakeDaemon(port);

    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

    const service = await runAcp([], {
      stdio: {
        input: clientToAgent.readable,
        output: agentToClient.writable,
      },
      ensureDaemon: false,
      controlWsUrl: `ws://127.0.0.1:${port}/ws`,
    });
    register(() => service.stop());

    const updates: CapturedUpdate[] = [];
    const recordingClient = makeRecordingClient(updates);

    const client = new ClientSideConnection(
      () =>
        recordingClient as unknown as ConstructorParameters<
          typeof ClientSideConnection
        >[0] extends (c: unknown) => infer R
          ? R
          : never,
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const init = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentInfo?.name).toBe("a2a-bridge");

    const session = await client.newSession({
      cwd: "/tmp/acp-cli-e2e",
      mcpServers: [],
    });

    const resp = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello acp cli" }],
    });
    expect(resp.stopReason).toBe("end_turn");

    // Let the sessionUpdate notifications flush.
    await new Promise((r) => setImmediate(r));

    const daemonReply = updates.find(
      (u) => u.kind === "agent_message_chunk" && u.text === "daemon: hello acp cli",
    );
    expect(daemonReply).toBeDefined();
    expect(daemonReply!.sessionId).toBe(session.sessionId);

    // Explicitly assert the old echo path is gone.
    const echoed = updates.find(
      (u) => u.kind === "agent_message_chunk" && u.text?.startsWith("Echo:"),
    );
    expect(echoed).toBeUndefined();
  });

  test("runAcp throws DaemonUnreachableError when the daemon is not listening", async () => {
    // Port 1 is reserved and almost never listening.
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

    await expect(
      runAcp([], {
        stdio: {
          input: clientToAgent.readable,
          output: agentToClient.writable,
        },
        ensureDaemon: false,
        controlWsUrl: "ws://127.0.0.1:1/ws",
      }),
    ).rejects.toBeInstanceOf(DaemonUnreachableError);
  });
});
