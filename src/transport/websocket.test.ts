import { describe, test, expect, afterEach } from "bun:test";
import type { Connection } from "@transport/listener";
import { WebSocketListener } from "@transport/websocket";

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
  // Ephemeral-range port, avoiding the range Bun's own tests tend to hit.
  return 45000 + Math.floor(Math.random() * 10000);
}

describe("WebSocketListener", () => {
  test("accepts a WS client and round-trips a text frame", async () => {
    const port = randomPort();
    const listener = new WebSocketListener({ port, path: "/ws" });
    register(() => listener.close());

    const serverConnPromise = new Promise<Connection>((resolve) =>
      listener.on("connection", (conn) => resolve(conn)),
    );

    await listener.listen();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    register(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("client open failed"));
    });

    const serverConn = await serverConnPromise;
    const gotOnServer = new Promise<string>((resolve) => {
      serverConn.on("message", (frame) => resolve(frame));
    });
    ws.send("hi-from-client");
    expect(await gotOnServer).toBe("hi-from-client");

    const gotOnClient = new Promise<string>((resolve) => {
      ws.onmessage = (ev) => resolve(typeof ev.data === "string" ? ev.data : ev.data.toString());
    });
    serverConn.send("hi-from-server");
    expect(await gotOnClient).toBe("hi-from-server");

    expect(serverConn.isOpen).toBe(true);
  });

  test("httpHandler handles non-WS traffic", async () => {
    const port = randomPort();
    const listener = new WebSocketListener({
      port,
      httpHandler: (req) => {
        if (new URL(req.url).pathname === "/healthz") {
          return Response.json({ ok: true });
        }
        return undefined;
      },
    });
    register(() => listener.close());

    await listener.listen();

    const healthResp = await fetch(`http://localhost:${port}/healthz`);
    expect(healthResp.status).toBe(200);
    expect(await healthResp.json()).toEqual({ ok: true });

    const missResp = await fetch(`http://localhost:${port}/missing`);
    expect(missResp.status).toBe(404);
  });

  test("close() tears down the server and emits close on active connections", async () => {
    const port = randomPort();
    const listener = new WebSocketListener({ port, path: "/ws" });

    const connPromise = new Promise<Connection>((resolve) =>
      listener.on("connection", (conn) => resolve(conn)),
    );

    await listener.listen();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("client open failed"));
    });

    const conn = await connPromise;
    const closed = new Promise<void>((resolve) => conn.on("close", resolve));

    await listener.close();
    await closed;

    expect(conn.isOpen).toBe(false);

    if (ws.readyState === WebSocket.OPEN) ws.close();
  });
});
