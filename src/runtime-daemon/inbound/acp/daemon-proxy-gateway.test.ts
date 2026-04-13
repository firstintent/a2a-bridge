/**
 * P8.3 — DaemonProxyGateway unit tests.
 *
 * Exercises the subprocess-side gateway against a fresh WebSocket
 * listener.  A helper rigs a fake daemon that echoes acp_turn frames
 * in a deterministic sequence so we can assert:
 *   - startTurn produces an acp_turn_start frame with the right fields.
 *   - acp_turn_chunk / complete / error frames reach the turn emitter.
 *   - cancel() sends acp_turn_cancel.
 *   - connect-before-send → meta keys validated; non-identifier keys throw.
 *   - daemon close mid-turn surfaces as an error on the in-flight turn.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Connection } from "@transport/listener";
import { WebSocketListener } from "@transport/websocket";
import { DaemonProxyGateway } from "@daemon/inbound/acp/daemon-proxy-gateway";
import type {
  ControlClientMessage,
  ControlServerMessage,
} from "@transport/control-protocol";

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
  return 47000 + Math.floor(Math.random() * 2000);
}

/**
 * Boot a WebSocketListener that acts as the daemon.  Returns immediately
 * after `listen()` resolves; callers `await daemon.firstConnection` when
 * they need the accepted `Connection`.  This split avoids a deadlock
 * where the test would wait for a client that hasn't connected yet.
 */
async function bootFakeDaemon(port: number): Promise<{
  listener: WebSocketListener;
  firstConnection: Promise<Connection>;
  received: ControlClientMessage[];
}> {
  const listener = new WebSocketListener({ port, path: "/ws" });
  register(() => listener.close());

  const received: ControlClientMessage[] = [];
  const firstConnection = new Promise<Connection>((resolve) =>
    listener.on("connection", (c) => {
      c.on("message", (raw: string) => {
        try {
          received.push(JSON.parse(raw) as ControlClientMessage);
        } catch {}
      });
      resolve(c);
    }),
  );
  await listener.listen();
  return { listener, firstConnection, received };
}

function sendFromDaemon(conn: Connection, msg: ControlServerMessage): void {
  conn.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DaemonProxyGateway — connect + startTurn wire format", () => {
  test("startTurn sends acp_turn_start with sessionId and meta", async () => {
    const port = randomPort();
    const gw = new DaemonProxyGateway({
      url: `ws://127.0.0.1:${port}/ws`,
      sessionId: "s1",
      meta: { room_id: "r1", source_type: "acp" },
    });
    register(() => gw.disconnect());

    const daemon = await bootFakeDaemon(port);
    await gw.connect();
    const daemonConn = await daemon.firstConnection;

    const turn = gw.startTurn("hello");

    // Give the frame a tick to arrive over the WS.
    await new Promise((r) => setTimeout(r, 20));

    expect(daemon.received).toHaveLength(1);
    const frame = daemon.received[0]!;
    expect(frame.type).toBe("acp_turn_start");
    if (frame.type === "acp_turn_start") {
      expect(frame.sessionId).toBe("s1");
      expect(frame.userText).toBe("hello");
      expect(frame.meta).toEqual({ room_id: "r1", source_type: "acp" });
      expect(typeof frame.turnId).toBe("string");
      expect(frame.turnId.length).toBeGreaterThan(0);
    }

    // Daemon completes the turn — gateway surfaces "complete" on the emitter.
    const completePromise = new Promise<void>((resolve) => turn.on("complete", resolve));
    if (frame.type === "acp_turn_start") {
      sendFromDaemon(daemonConn, { type: "acp_turn_complete", turnId: frame.turnId });
    }
    await completePromise;
  });

  test("constructor throws on non-identifier-safe meta key", () => {
    expect(
      () =>
        new DaemonProxyGateway({
          url: "ws://127.0.0.1:1",
          meta: { "bad-key": "nope" },
        }),
    ).toThrow(/identifier-safe/);
  });
});

describe("DaemonProxyGateway — turn event relay", () => {
  test("acp_turn_chunk frames surface as chunk events; acp_turn_complete terminates", async () => {
    const port = randomPort();
    const gw = new DaemonProxyGateway({ url: `ws://127.0.0.1:${port}/ws` });
    register(() => gw.disconnect());

    const daemon = await bootFakeDaemon(port);
    await gw.connect();
    const daemonConn = await daemon.firstConnection;

    const turn = gw.startTurn("query");
    await new Promise((r) => setTimeout(r, 10));
    const firstFrame = daemon.received[0]!;
    expect(firstFrame.type).toBe("acp_turn_start");
    const turnId = firstFrame.type === "acp_turn_start" ? firstFrame.turnId : "";

    const chunks: string[] = [];
    turn.on("chunk", (t) => chunks.push(t));
    const completeP = new Promise<void>((resolve) => turn.on("complete", resolve));

    sendFromDaemon(daemonConn, { type: "acp_turn_chunk", turnId, text: "hello " });
    sendFromDaemon(daemonConn, { type: "acp_turn_chunk", turnId, text: "world" });
    sendFromDaemon(daemonConn, { type: "acp_turn_complete", turnId });

    await completeP;
    expect(chunks).toEqual(["hello ", "world"]);
  });

  test("acp_turn_error frame surfaces as an error event with the message", async () => {
    const port = randomPort();
    const gw = new DaemonProxyGateway({ url: `ws://127.0.0.1:${port}/ws` });
    register(() => gw.disconnect());

    const daemon = await bootFakeDaemon(port);
    await gw.connect();
    const daemonConn = await daemon.firstConnection;

    const turn = gw.startTurn("query");
    await new Promise((r) => setTimeout(r, 10));
    const firstFrame = daemon.received[0]!;
    const turnId = firstFrame.type === "acp_turn_start" ? firstFrame.turnId : "";

    const errP = new Promise<Error>((resolve) => turn.on("error", resolve));
    sendFromDaemon(daemonConn, {
      type: "acp_turn_error",
      turnId,
      message: "daemon rejected the turn",
    });
    const err = await errP;
    expect(err.message).toBe("daemon rejected the turn");
  });
});

describe("DaemonProxyGateway — cancel + error paths", () => {
  test("turn.cancel() sends acp_turn_cancel over the WS", async () => {
    const port = randomPort();
    const gw = new DaemonProxyGateway({ url: `ws://127.0.0.1:${port}/ws` });
    register(() => gw.disconnect());

    const daemon = await bootFakeDaemon(port);
    await gw.connect();
    const daemonConn = await daemon.firstConnection;

    const turn = gw.startTurn("long");
    await new Promise((r) => setTimeout(r, 10));
    turn.cancel();
    await new Promise((r) => setTimeout(r, 20));

    expect(daemon.received.map((m) => m.type)).toEqual([
      "acp_turn_start",
      "acp_turn_cancel",
    ]);
  });

  test("startTurn before connect() surfaces an error asynchronously", async () => {
    const gw = new DaemonProxyGateway({ url: `ws://127.0.0.1:1/ws` });
    // Do NOT connect — keeps the WS null.
    const turn = gw.startTurn("will fail");
    const err = await new Promise<Error>((resolve) => turn.on("error", resolve));
    expect(err.message).toMatch(/not connected/);
  });

  test("daemon close mid-turn surfaces as error on in-flight turns", async () => {
    const port = randomPort();
    const gw = new DaemonProxyGateway({ url: `ws://127.0.0.1:${port}/ws` });
    register(() => gw.disconnect());

    const daemon = await bootFakeDaemon(port);
    await gw.connect();
    const daemonConn = await daemon.firstConnection;

    const turn = gw.startTurn("long running");
    await new Promise((r) => setTimeout(r, 10));

    const disconnectP = new Promise<void>((resolve) => gw.on("disconnect", resolve));
    const errP = new Promise<Error>((resolve) => turn.on("error", resolve));

    daemonConn.close();

    const err = await errP;
    expect(err.message).toMatch(/Daemon WebSocket closed/);
    await disconnectP;
    expect(gw.isConnected).toBe(false);
  });

  test("connect() rejects when the daemon is not reachable", async () => {
    // Pick a port that's almost certainly not bound.
    const gw = new DaemonProxyGateway({
      url: `ws://127.0.0.1:1/ws`,
      connectTimeoutMs: 500,
    });
    await expect(gw.connect()).rejects.toThrow();
  });
});
