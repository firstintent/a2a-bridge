import { describe, test, expect } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { Connection } from "@transport/listener";
import { StdioListener } from "@transport/stdio";

function makeStreams(): { input: Readable; output: Writable; writtenChunks: string[] } {
  const input = new Readable({ read() {} });
  const writtenChunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      writtenChunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { input, output, writtenChunks };
}

async function awaitConnection(listener: StdioListener): Promise<Connection> {
  return new Promise<Connection>((resolve) => {
    listener.on("connection", (conn) => resolve(conn));
  });
}

describe("StdioListener", () => {
  test("listen() emits exactly one connection event", async () => {
    const { input, output } = makeStreams();
    const listener = new StdioListener({ input, output });

    let count = 0;
    listener.on("connection", () => {
      count += 1;
    });

    await listener.listen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(count).toBe(1);

    await listener.close();
  });

  test("Connection emits newline-delimited frames from input", async () => {
    const { input, output } = makeStreams();
    const listener = new StdioListener({ input, output });
    const connPromise = awaitConnection(listener);
    await listener.listen();
    const conn = await connPromise;

    const frames: string[] = [];
    const got = new Promise<void>((resolve) => {
      conn.on("message", (frame) => {
        frames.push(frame);
        if (frames.length === 2) resolve();
      });
    });

    input.push("hello\nworld\n");
    await got;

    expect(frames).toEqual(["hello", "world"]);

    await listener.close();
  });

  test("Connection buffers partial frames until newline arrives", async () => {
    const { input, output } = makeStreams();
    const listener = new StdioListener({ input, output });
    const connPromise = awaitConnection(listener);
    await listener.listen();
    const conn = await connPromise;

    const gotFrame = new Promise<string>((resolve) => {
      conn.on("message", (frame) => resolve(frame));
    });

    input.push("par");
    input.push("tial-");
    input.push("frame\n");

    expect(await gotFrame).toBe("partial-frame");

    await listener.close();
  });

  test("send() writes frame plus newline to output", async () => {
    const { input, output, writtenChunks } = makeStreams();
    const listener = new StdioListener({ input, output });
    const connPromise = awaitConnection(listener);
    await listener.listen();
    const conn = await connPromise;

    conn.send("ping");
    conn.send("pong");

    expect(writtenChunks.join("")).toBe("ping\npong\n");

    await listener.close();
  });

  test("close() emits close on the connection and marks it closed", async () => {
    const { input, output } = makeStreams();
    const listener = new StdioListener({ input, output });
    const connPromise = awaitConnection(listener);
    await listener.listen();
    const conn = await connPromise;

    const closed = new Promise<void>((resolve) => conn.on("close", resolve));
    await listener.close();
    await closed;

    expect(conn.isOpen).toBe(false);
    expect(() => conn.send("late")).toThrow();
  });

  test("listen() twice throws", async () => {
    const { input, output } = makeStreams();
    const listener = new StdioListener({ input, output });
    await listener.listen();

    await expect(listener.listen()).rejects.toThrow(/already listening/);

    await listener.close();
  });
});
