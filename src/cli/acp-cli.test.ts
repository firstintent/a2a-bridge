import { describe, test, expect } from "bun:test";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { runAcp } from "./acp";

/**
 * E2E: `a2a-bridge acp` round-trip (P5.6).
 *
 * Filtered out of the default `test:unit` run by the `E2E:` prefix in
 * the test name — CI executes it only when explicitly requested.
 *
 * Drives `runAcp()` with an in-memory stdio pair (same technique the
 * unit tests use), so we exercise the CLI entrypoint without spawning
 * a real subprocess. Asserts the full ACP initialize → newSession →
 * prompt → reply round trip against the v0.1 echo gateway.
 */

interface CapturedUpdate {
  sessionId: string;
  kind: string;
  text?: string;
}

describe("E2E: a2a-bridge acp CLI subcommand", () => {
  test("initialize → newSession → prompt returns echo reply end-to-end", async () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

    const service = await runAcp([], {
      stdio: {
        input: clientToAgent.readable,
        output: agentToClient.writable,
      },
      ensureDaemon: false,
    });

    const updates: CapturedUpdate[] = [];
    const recordingClient = {
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
    expect(typeof session.sessionId).toBe("string");

    const resp = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello acp cli" }],
    });
    expect(resp.stopReason).toBe("end_turn");

    // Let the final sessionUpdate notification flush.
    await new Promise((r) => setImmediate(r));
    const echoed = updates.find(
      (u) => u.kind === "agent_message_chunk" && u.text === "Echo: hello acp cli",
    );
    expect(echoed).toBeDefined();
    expect(echoed!.sessionId).toBe(session.sessionId);

    await service.stop();
  });
});
