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
 * Minimal ACP client stub — the ACP SDK requires callers to implement
 * the full `Client` surface, but our tests only consume the agent's
 * side so every method can no-op / throw.
 */
interface SessionUpdateRecord {
  sessionId: string;
  kind: string;
  text?: string;
}

function makeRecordingClient() {
  const updates: SessionUpdateRecord[] = [];
  const client = {
    async sessionUpdate(params: {
      sessionId: string;
      update: { sessionUpdate: string; content?: { type: string; text: string } };
    }): Promise<void> {
      const kind = params.update.sessionUpdate;
      const text =
        params.update.content?.type === "text"
          ? params.update.content.text
          : undefined;
      updates.push({ sessionId: params.sessionId, kind, text });
    },
    async requestPermission(): Promise<never> {
      throw new Error("test client: requestPermission not implemented");
    },
    async readTextFile(): Promise<never> {
      throw new Error("test client: readTextFile not implemented");
    },
    async writeTextFile(): Promise<never> {
      throw new Error("test client: writeTextFile not implemented");
    },
  };
  return { client, updates };
}

const noopClient = makeRecordingClient().client;

class StubTurn extends EventEmitter implements ClaudeCodeTurn {
  cancelCalls = 0;
  cancel(): void {
    this.cancelCalls += 1;
  }
}

class StubGateway implements ClaudeCodeGateway {
  readonly turns: StubTurn[] = [];
  startTurn(_userText: string): ClaudeCodeTurn {
    const turn = new StubTurn();
    this.turns.push(turn);
    return turn;
  }
  emitOn(turnIndex: number, event: "chunk" | "complete" | "error", payload?: unknown): void {
    const turn = this.turns[turnIndex];
    if (!turn) throw new Error(`no turn at index ${turnIndex}`);
    if (event === "chunk") turn.emit("chunk", payload as string);
    else if (event === "complete") turn.emit("complete");
    else turn.emit("error", payload as Error);
  }
}

function buildInMemoryPair(options: {
  gateway?: ClaudeCodeGateway;
  clientImpl?: unknown;
} = {}) {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

  const service = new AcpInboundService({
    stdio: {
      input: clientToAgent.readable,
      output: agentToClient.writable,
    },
    gateway: options.gateway,
  });

  void service.start();

  const clientImpl = options.clientImpl ?? noopClient;
  const client = new ClientSideConnection(
    () =>
      clientImpl as unknown as ConstructorParameters<
        typeof ClientSideConnection
      >[0] extends (c: unknown) => infer R
        ? R
        : never,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );

  return { service, client };
}

describe("AcpInboundService handshake (P5.3)", () => {
  test("initialize returns the agent's protocol version + capabilities", async () => {
    const { client } = buildInMemoryPair();
    const resp = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "test-client", version: "0.0.0" },
      clientCapabilities: {},
    });
    expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(resp.agentInfo?.name).toBe("a2a-bridge");
    expect(resp.agentCapabilities).toBeDefined();
    expect(resp.agentCapabilities?.loadSession).toBe(false);
  });

  test("initialize still negotiates when the client advertises a different version", async () => {
    const { client } = buildInMemoryPair();
    const resp = await client.initialize({
      protocolVersion: PROTOCOL_VERSION + 99,
      clientCapabilities: {},
    });
    // The agent caps the negotiated version at its own latest.
    expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test("newSession mints a non-empty session id and counts as active", async () => {
    const { service, client } = buildInMemoryPair();
    expect(service.sessionCount()).toBe(0);

    const resp = await client.newSession({
      cwd: "/tmp/acp-test",
      mcpServers: [],
    });
    expect(typeof resp.sessionId).toBe("string");
    expect(resp.sessionId.length).toBeGreaterThan(0);
    expect(service.sessionCount()).toBe(1);

    // Distinct cwd mints a distinct id.
    const second = await client.newSession({
      cwd: "/tmp/acp-test-2",
      mcpServers: [],
    });
    expect(second.sessionId).not.toBe(resp.sessionId);
    expect(service.sessionCount()).toBe(2);
  });

  test("start without a stdio pair throws a clear error", async () => {
    const service = new AcpInboundService({});
    await expect(service.start()).rejects.toThrow(/no stdio pair/);
  });

  test("start twice rejects to prevent double-binding the same stream", async () => {
    const { service } = buildInMemoryPair();
    // Re-arm start — defaultStdio isn't reusable in real code, but the
    // guard should trip before we try.
    await expect(service.start()).rejects.toThrow(/already started/);
  });
});

describe("AcpInboundService prompt → ClaudeCodeGateway (P5.4)", () => {
  test("streams each gateway chunk as an agent_message_chunk session/update and ends with end_turn", async () => {
    const recorder = makeRecordingClient();
    const gateway = new StubGateway();
    const { client } = buildInMemoryPair({
      gateway,
      clientImpl: recorder.client,
    });

    const session = await client.newSession({
      cwd: "/tmp/acp-prompt",
      mcpServers: [],
    });

    const promptPromise = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello gateway" }],
    });

    // Yield so the ACP agent's prompt handler has called startTurn.
    while (gateway.turns.length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    gateway.emitOn(0, "chunk", "first ");
    gateway.emitOn(0, "chunk", "second");
    gateway.emitOn(0, "complete");

    const resp = await promptPromise;
    expect(resp.stopReason).toBe("end_turn");

    // Yield once more so the final sessionUpdate notifications flush.
    await new Promise((r) => setImmediate(r));
    const texts = recorder.updates
      .filter((u) => u.kind === "agent_message_chunk")
      .map((u) => u.text);
    expect(texts).toEqual(["first ", "second"]);
    expect(recorder.updates.every((u) => u.sessionId === session.sessionId)).toBe(true);
  });

  test("gateway error surfaces as stopReason: refusal with the message in a session/update", async () => {
    const recorder = makeRecordingClient();
    const gateway = new StubGateway();
    const { client } = buildInMemoryPair({
      gateway,
      clientImpl: recorder.client,
    });
    const session = await client.newSession({
      cwd: "/tmp/acp-err",
      mcpServers: [],
    });

    const promptPromise = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "will fail" }],
    });
    while (gateway.turns.length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    gateway.emitOn(0, "error", new Error("boom"));

    const resp = await promptPromise;
    expect(resp.stopReason).toBe("refusal");

    await new Promise((r) => setImmediate(r));
    const refusalText = recorder.updates.find(
      (u) => u.kind === "agent_message_chunk" && u.text?.includes("boom"),
    );
    expect(refusalText).toBeDefined();
  });

  test("no gateway configured → prompt refuses with an explanatory chunk", async () => {
    const recorder = makeRecordingClient();
    const { client } = buildInMemoryPair({ clientImpl: recorder.client });
    const session = await client.newSession({
      cwd: "/tmp/acp-nogw",
      mcpServers: [],
    });
    const resp = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(resp.stopReason).toBe("refusal");
    const refusal = recorder.updates.find((u) => u.text?.includes("no ClaudeCodeGateway"));
    expect(refusal).toBeDefined();
  });
});

describe("AcpInboundService cancel (P5.5)", () => {
  test("session/cancel calls turn.cancel and resolves the pending prompt with cancelled", async () => {
    const recorder = makeRecordingClient();
    const gateway = new StubGateway();
    const { client } = buildInMemoryPair({
      gateway,
      clientImpl: recorder.client,
    });
    const session = await client.newSession({
      cwd: "/tmp/acp-cancel",
      mcpServers: [],
    });

    const promptPromise = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "start a long turn" }],
    });
    while (gateway.turns.length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    const turn = gateway.turns[0] as StubTurn;

    // Client cancels the in-flight prompt. `cancel` is a notification,
    // so no response to await; the pending `prompt` promise should
    // settle once the gateway's stream flushes its terminal event.
    await client.cancel({ sessionId: session.sessionId });

    // Give the cancel handler a tick to land; then emit the gateway's
    // own terminal so the runPromptTurn listeners resolve.
    await new Promise((r) => setImmediate(r));
    expect(turn.cancelCalls).toBe(1);
    gateway.emitOn(0, "complete");

    const resp = await promptPromise;
    expect(resp.stopReason).toBe("cancelled");
  });

  test("cancel for an unknown session is a no-op", async () => {
    const recorder = makeRecordingClient();
    const gateway = new StubGateway();
    const { client } = buildInMemoryPair({
      gateway,
      clientImpl: recorder.client,
    });
    // No prior newSession for "ghost" — cancel should resolve cleanly.
    await expect(client.cancel({ sessionId: "ghost" })).resolves.toBeUndefined();
  });
});
