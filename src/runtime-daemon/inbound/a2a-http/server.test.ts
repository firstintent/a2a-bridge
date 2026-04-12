import { describe, test, expect, afterEach } from "bun:test";
import { startA2AServer, type A2aServerHandle } from "@daemon/inbound/a2a-http/server";

const teardown: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (teardown.length) {
    try {
      await teardown.pop()!();
    } catch {}
  }
});

function randomPort(): number {
  return 45000 + Math.floor(Math.random() * 10000);
}

function cardConfig(port: number) {
  return { url: `http://localhost:${port}/a2a` };
}

type SilentConfig = {
  port: number;
  logger: () => void;
  agentCard: { url: string };
  bearerToken: string;
  publicAgentCard: boolean;
};

function silent(port: number, overrides: Partial<SilentConfig> = {}): SilentConfig {
  return {
    port,
    logger: () => {},
    agentCard: cardConfig(port),
    bearerToken: "test-token",
    publicAgentCard: true,
    ...overrides,
  };
}

function track(handle: A2aServerHandle) {
  teardown.push(() => handle.shutdown());
  return handle;
}

describe("startA2AServer", () => {
  test("GET /healthz returns 200 ok", async () => {
    const server = track(await startA2AServer(silent(randomPort())));
    const resp = await fetch(`http://localhost:${server.port}/healthz`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });

  test("unknown paths return 404", async () => {
    const server = track(await startA2AServer(silent(randomPort())));
    const resp = await fetch(`http://localhost:${server.port}/nope`);
    expect(resp.status).toBe(404);
  });

  test("each request is emitted through the logger", async () => {
    const lines: string[] = [];
    const port = randomPort();
    const server = track(
      await startA2AServer({
        port,
        logger: (msg) => {
          lines.push(msg);
        },
        agentCard: cardConfig(port),
        bearerToken: "t",
        publicAgentCard: true,
      }),
    );

    await fetch(`http://localhost:${server.port}/healthz`);
    await fetch(`http://localhost:${server.port}/nope`);

    const requestLines = lines.filter((line) => line.includes("GET /"));
    expect(requestLines).toEqual(["GET /healthz", "GET /nope"]);
  });

  test("shutdown() releases the port", async () => {
    const port = randomPort();
    const server = await startA2AServer(silent(port));
    await server.shutdown();

    const replacement = track(await startA2AServer(silent(port)));
    expect(replacement.port).toBe(port);
  });

  test("GET /.well-known/agent-card.json returns the built card as JSON when public", async () => {
    const port = randomPort();
    const server = track(
      await startA2AServer({
        port,
        logger: () => {},
        agentCard: { url: `http://localhost:${port}/a2a`, version: "1.2.3" },
        bearerToken: "t",
        publicAgentCard: true,
      }),
    );

    const resp = await fetch(`http://localhost:${server.port}/.well-known/agent-card.json`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/^application\/json/);

    const body = (await resp.json()) as {
      protocolVersion: string;
      url: string;
      version: string;
      capabilities: { streaming: boolean };
      skills: unknown[];
      securitySchemes: Record<string, { type: string; scheme: string }>;
    };

    expect(body.protocolVersion).toBe("0.3.0");
    expect(body.version).toBe("1.2.3");
    expect(body.capabilities.streaming).toBe(true);
    expect(body.skills.length).toBeGreaterThanOrEqual(1);
    const [[, scheme]] = Object.entries(body.securitySchemes);
    expect(scheme!.type).toBe("http");
    expect(scheme!.scheme).toBe("bearer");
  });

  test("agent-card requires auth when publicAgentCard is false", async () => {
    const port = randomPort();
    const server = track(
      await startA2AServer(silent(port, { publicAgentCard: false, bearerToken: "secret" })),
    );

    const denied = await fetch(`http://localhost:${server.port}/.well-known/agent-card.json`);
    expect(denied.status).toBe(401);

    const ok = await fetch(`http://localhost:${server.port}/.well-known/agent-card.json`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
  });

  test("POST rpcPath with tasks/get returns a -32001 error for unknown ids", async () => {
    const port = randomPort();
    const server = track(await startA2AServer(silent(port, { bearerToken: "tok" })));

    const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: "nope" },
        id: 1,
      }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });

  test("POST rpcPath rejects missing bearer token with 401", async () => {
    const port = randomPort();
    const server = track(await startA2AServer(silent(port, { bearerToken: "tok" })));
    const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tasks/get", id: 1 }),
    });
    expect(resp.status).toBe(401);
  });

  test("POST rpcPath with message/stream returns text/event-stream (echo executor)", async () => {
    const port = randomPort();
    const server = track(await startA2AServer(silent(port, { bearerToken: "tok" })));

    const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/stream",
        params: { message: { parts: [{ kind: "text", text: "ping" }] } },
        id: "m1",
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const text = await resp.text();
    const frames = text
      .split("\n\n")
      .filter((r) => r.startsWith("data: "))
      .map((r) => JSON.parse(r.slice("data: ".length)));
    expect(frames.length).toBe(4);
    const last = frames[3].result as { final: boolean; status: { state: string } };
    expect(last.final).toBe(true);
    expect(last.status.state).toBe("completed");
  });
});
