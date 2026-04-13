import { describe, test, expect } from "bun:test";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { AcpInboundService } from "@daemon/inbound/acp";

/**
 * Minimal ACP client stub — the ACP SDK requires callers to implement
 * the full `Client` surface, but our tests only consume the agent's
 * side so every method can no-op / throw.
 */
const noopClient = {
  async sessionUpdate(): Promise<void> {},
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

function buildInMemoryPair(): {
  service: AcpInboundService;
  client: ClientSideConnection;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

  const service = new AcpInboundService({
    stdio: {
      input: clientToAgent.readable,
      output: agentToClient.writable,
    },
  });

  void service.start();

  const client = new ClientSideConnection(
    () => noopClient as unknown as ConstructorParameters<typeof ClientSideConnection>[0] extends (c: unknown) => infer R ? R : never,
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
