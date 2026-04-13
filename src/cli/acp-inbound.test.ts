import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { AcpInboundService } from "@daemon/inbound/acp";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";

/**
 * SDK-level ACP integration test (P5.8).
 *
 * Unlike the unit tests under `runtime-daemon/inbound/acp/` which
 * exercise `AcpInboundService` at the agent-factory seam, this test
 * boots the service against an in-memory stdio pair and drives it
 * with `ClientSideConnection` — the exact class Zed / VS Code / the
 * `acpx` CLI use on their end. It validates the wire contract end
 * to end: initialize → newSession → prompt streams at least one
 * `session/update` notification, and the terminal response carries
 * `stopReason: "end_turn"`.
 */

class StubTurn extends EventEmitter implements ClaudeCodeTurn {
  cancel(): void {}
}

class ChunkGateway implements ClaudeCodeGateway {
  constructor(private readonly chunks: string[]) {}
  startTurn(_userText: string): ClaudeCodeTurn {
    const turn = new StubTurn();
    setImmediate(() => {
      for (const c of this.chunks) turn.emit("chunk", c);
      turn.emit("complete");
    });
    return turn;
  }
}

interface SdkUpdate {
  sessionId: string;
  kind: string;
  text?: string;
}

describe("AcpInboundService — SDK integration (P5.8)", () => {
  test("prompt streams at least one session/update and resolves with end_turn", async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

    const service = new AcpInboundService({
      stdio: {
        input: clientToAgent.readable,
        output: agentToClient.writable,
      },
      gateway: new ChunkGateway(["first ", "second"]),
    });
    await service.start();

    const updates: SdkUpdate[] = [];
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
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    const init = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentInfo?.name).toBe("a2a-bridge");

    const session = await client.newSession({
      cwd: "/tmp/acp-sdk-inbound",
      mcpServers: [],
    });
    expect(session.sessionId.length).toBeGreaterThan(0);

    const resp = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "stream me" }],
    });
    expect(resp.stopReason).toBe("end_turn");

    // Flush pending notifications.
    await new Promise((r) => setImmediate(r));
    const streamed = updates.filter(
      (u) => u.kind === "agent_message_chunk" && u.sessionId === session.sessionId,
    );
    expect(streamed.length).toBeGreaterThanOrEqual(1);
    expect(streamed.map((u) => u.text).join("")).toBe("first second");

    await service.stop();
  });
});
