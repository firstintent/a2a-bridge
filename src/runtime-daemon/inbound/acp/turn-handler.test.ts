/**
 * P8.2 — Daemon-side ACP turn handler unit tests.
 *
 * Uses a stub ClaudeCodeGateway and a fake Connection to verify the
 * control-plane frame sequence produced by AcpTurnHandler.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { AcpTurnHandler } from "@daemon/inbound/acp/turn-handler";
import type { Connection } from "@transport/listener";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";
import type { ControlServerMessage } from "@transport/control-protocol";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubTurn extends EventEmitter implements ClaudeCodeTurn {
  cancelCalls = 0;
  cancel(): void {
    this.cancelCalls += 1;
  }
}

class StubGateway implements ClaudeCodeGateway {
  turns: StubTurn[] = [];
  startTurn(_userText: string): ClaudeCodeTurn {
    const t = new StubTurn();
    this.turns.push(t);
    return t;
  }
  get lastTurn(): StubTurn {
    return this.turns[this.turns.length - 1]!;
  }
}

class FakeConnection extends EventEmitter implements Connection {
  private _open = true;
  sent: ControlServerMessage[] = [];

  get isOpen(): boolean {
    return this._open;
  }

  send(frame: string): void {
    this.sent.push(JSON.parse(frame) as ControlServerMessage);
  }

  close(): void {
    this._open = false;
    this.emit("close");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AcpTurnHandler — happy path", () => {
  test("acp_turn_start forwards text to gateway and relays chunk+complete frames", () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(gw);

    handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t1",
      sessionId: "s1",
      userText: "hello",
    });

    const turn = gw.lastTurn;
    expect(turn).toBeDefined();

    turn.emit("chunk", "world");
    turn.emit("chunk", "!");
    turn.emit("complete");

    expect(conn.sent).toEqual([
      { type: "acp_turn_chunk", turnId: "t1", text: "world" },
      { type: "acp_turn_chunk", turnId: "t1", text: "!" },
      { type: "acp_turn_complete", turnId: "t1" },
    ]);
  });

  test("gateway error produces an acp_turn_error frame", () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(gw);

    handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t2",
      sessionId: "s1",
      userText: "will fail",
    });

    gw.lastTurn.emit("error", new Error("CC unavailable"));

    expect(conn.sent).toEqual([
      { type: "acp_turn_error", turnId: "t2", message: "CC unavailable" },
    ]);
  });
});

describe("AcpTurnHandler — cancel", () => {
  test("acp_turn_cancel calls turn.cancel() and suppresses subsequent events", () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(gw);

    handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t3",
      sessionId: "s1",
      userText: "long task",
    });
    const turn = gw.lastTurn;

    handler.handleTurnCancel(conn, { type: "acp_turn_cancel", turnId: "t3" });
    expect(turn.cancelCalls).toBe(1);

    // Events after cancel should not produce new frames (turn is deregistered).
    turn.emit("chunk", "too late");
    turn.emit("complete");

    // No frames sent — cancel happened before any events
    expect(conn.sent).toEqual([]);
  });

  test("cancel for an unknown turnId is a no-op", () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(gw);

    // No active turn for this connection
    expect(() =>
      handler.handleTurnCancel(conn, { type: "acp_turn_cancel", turnId: "ghost" }),
    ).not.toThrow();
  });

  test("cancel with wrong turnId on same connection is a no-op", () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(gw);

    handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t4",
      sessionId: "s1",
      userText: "some text",
    });
    const turn = gw.lastTurn;

    // Wrong turnId — should not cancel the active t4 turn
    handler.handleTurnCancel(conn, { type: "acp_turn_cancel", turnId: "wrong" });
    expect(turn.cancelCalls).toBe(0);

    // t4 can still complete normally
    turn.emit("chunk", "ok");
    turn.emit("complete");
    expect(conn.sent).toEqual([
      { type: "acp_turn_chunk", turnId: "t4", text: "ok" },
      { type: "acp_turn_complete", turnId: "t4" },
    ]);
  });
});

describe("AcpTurnHandler — supersede + connection close", () => {
  test("a second acp_turn_start on the same connection cancels the previous turn", () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(gw);

    handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t5",
      sessionId: "s1",
      userText: "first",
    });
    const first = gw.turns[0]!;

    handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t6",
      sessionId: "s1",
      userText: "second",
    });
    const second = gw.turns[1]!;

    expect(first.cancelCalls).toBe(1);

    // Events from t5 arrive but are ignored (it was deregistered).
    first.emit("chunk", "stale");

    // Only t6 is active.
    second.emit("chunk", "fresh");
    second.emit("complete");

    expect(conn.sent).toEqual([
      { type: "acp_turn_chunk", turnId: "t6", text: "fresh" },
      { type: "acp_turn_complete", turnId: "t6" },
    ]);
  });

  test("onConnectionClose cancels an in-flight turn", () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(gw);

    handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t7",
      sessionId: "s1",
      userText: "in flight",
    });
    const turn = gw.lastTurn;

    handler.onConnectionClose(conn);
    expect(turn.cancelCalls).toBe(1);

    // Events after close don't produce frames (conn is closed).
    conn["_open"] = false;
    turn.emit("chunk", "dropped");
    expect(conn.sent).toEqual([]);
  });

  test("onConnectionClose with no active turn is a no-op", () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(gw);

    expect(() => handler.onConnectionClose(conn)).not.toThrow();
  });
});
