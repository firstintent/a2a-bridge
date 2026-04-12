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

function track(handle: A2aServerHandle) {
  teardown.push(() => handle.shutdown());
  return handle;
}

describe("startA2AServer", () => {
  test("GET /healthz returns 200 ok", async () => {
    const server = track(
      await startA2AServer({ port: randomPort(), logger: () => {} }),
    );
    const resp = await fetch(`http://localhost:${server.port}/healthz`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });

  test("unknown paths return 404", async () => {
    const server = track(
      await startA2AServer({ port: randomPort(), logger: () => {} }),
    );
    const resp = await fetch(`http://localhost:${server.port}/nope`);
    expect(resp.status).toBe(404);
  });

  test("each request is emitted through the logger", async () => {
    const lines: string[] = [];
    const server = track(
      await startA2AServer({
        port: randomPort(),
        logger: (msg) => {
          lines.push(msg);
        },
      }),
    );

    await fetch(`http://localhost:${server.port}/healthz`);
    await fetch(`http://localhost:${server.port}/nope`);

    const requestLines = lines.filter((line) => line.includes("GET /"));
    expect(requestLines).toEqual(["GET /healthz", "GET /nope"]);
  });

  test("shutdown() releases the port", async () => {
    const port = randomPort();
    const server = await startA2AServer({ port, logger: () => {} });
    await server.shutdown();

    // Re-binding the same port must succeed now that the first server is gone.
    const replacement = track(await startA2AServer({ port, logger: () => {} }));
    expect(replacement.port).toBe(port);
  });
});
