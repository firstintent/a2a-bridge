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

type SilentConfigExtras = {
  port: number;
  logger: () => void;
  agentCard: { url: string };
};

function silent(port: number): SilentConfigExtras {
  return { port, logger: () => {}, agentCard: cardConfig(port) };
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

    // Re-binding the same port must succeed now that the first server is gone.
    const replacement = track(await startA2AServer(silent(port)));
    expect(replacement.port).toBe(port);
  });

  test("GET /.well-known/agent-card.json returns the built card as JSON", async () => {
    const port = randomPort();
    const server = track(
      await startA2AServer({
        port,
        logger: () => {},
        agentCard: { url: `http://localhost:${port}/a2a`, version: "1.2.3" },
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
    expect(body.url).toBe(`http://localhost:${port}/a2a`);
    expect(body.version).toBe("1.2.3");
    expect(body.capabilities.streaming).toBe(true);
    expect(body.skills.length).toBeGreaterThanOrEqual(1);
    const [[, scheme]] = Object.entries(body.securitySchemes);
    expect(scheme!.type).toBe("http");
    expect(scheme!.scheme).toBe("bearer");
  });
});
