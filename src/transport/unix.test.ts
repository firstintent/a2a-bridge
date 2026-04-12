import { describe, test, expect, afterEach } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "@transport/listener";
import { UnixSocketListener } from "@transport/unix";

const cleanups: Array<() => Promise<void> | void> = [];

function registerCleanup(fn: () => Promise<void> | void) {
  cleanups.push(fn);
}

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch {}
  }
});

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "a2a-unix-"));
  registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "sock");
}

async function client(path: string): Promise<Socket> {
  const socket = createConnection({ path });
  registerCleanup(() => {
    if (!socket.destroyed) socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

describe("UnixSocketListener", () => {
  test("accepts a client connection and receives a frame", async () => {
    const path = tempSocketPath();
    const listener = new UnixSocketListener({ path });
    registerCleanup(() => listener.close());

    const connPromise = new Promise<Connection>((resolve) =>
      listener.on("connection", (conn) => resolve(conn)),
    );

    await listener.listen();
    const c = await client(path);
    const conn = await connPromise;

    const frame = await new Promise<string>((resolve) => {
      conn.on("message", (f) => resolve(f));
      c.write("hello\n");
    });

    expect(frame).toBe("hello");
  });

  test("accepts multiple concurrent clients", async () => {
    const path = tempSocketPath();
    const listener = new UnixSocketListener({ path });
    registerCleanup(() => listener.close());

    const incoming: Connection[] = [];
    listener.on("connection", (conn) => incoming.push(conn));

    await listener.listen();

    await client(path);
    await client(path);
    await client(path);

    // Wait a tick for "connection" events to fire
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(incoming.length).toBe(3);
  });

  test("Connection.send() writes a frame to the client", async () => {
    const path = tempSocketPath();
    const listener = new UnixSocketListener({ path });
    registerCleanup(() => listener.close());

    const connPromise = new Promise<Connection>((resolve) =>
      listener.on("connection", (conn) => resolve(conn)),
    );
    await listener.listen();

    const c = await client(path);
    c.setEncoding("utf8");
    const received = new Promise<string>((resolve) => {
      let buf = "";
      c.on("data", (chunk) => {
        buf += chunk;
        const idx = buf.indexOf("\n");
        if (idx !== -1) resolve(buf.slice(0, idx));
      });
    });

    const conn = await connPromise;
    conn.send("pong");

    expect(await received).toBe("pong");
  });

  test("listen() rejects if the path is already bound by this listener", async () => {
    const path = tempSocketPath();
    const listener = new UnixSocketListener({ path });
    registerCleanup(() => listener.close());

    await listener.listen();
    await expect(listener.listen()).rejects.toThrow(/already listening/);
  });

  test("close() disconnects active connections and unlinks the socket", async () => {
    const path = tempSocketPath();
    const listener = new UnixSocketListener({ path });

    const connPromise = new Promise<Connection>((resolve) =>
      listener.on("connection", (conn) => resolve(conn)),
    );
    await listener.listen();

    const c = await client(path);
    const conn = await connPromise;

    const closed = new Promise<void>((resolve) => conn.on("close", resolve));
    await listener.close();
    await closed;

    // Fresh connect on the same path should now fail.
    await expect(
      new Promise<void>((resolve, reject) => {
        const s = createConnection({ path });
        s.once("connect", () => {
          s.destroy();
          resolve();
        });
        s.once("error", reject);
      }),
    ).rejects.toThrow();

    // Cleanup c if it isn't already closed by the server teardown.
    if (!c.destroyed) c.destroy();
  });
});
