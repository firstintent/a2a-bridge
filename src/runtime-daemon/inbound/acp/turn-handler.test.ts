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

describe("AcpTurnHandler — happy path", async () => {
  test("acp_turn_start forwards text to gateway and relays chunk+complete frames", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    await handler.handleTurnStart(conn, {
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

  test("gateway error produces an acp_turn_error frame", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    await handler.handleTurnStart(conn, {
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

describe("AcpTurnHandler — cancel", async () => {
  test("acp_turn_cancel calls turn.cancel() and suppresses subsequent events", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    await handler.handleTurnStart(conn, {
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

  test("cancel for an unknown turnId is a no-op", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    // No active turn for this connection
    expect(() =>
      handler.handleTurnCancel(conn, { type: "acp_turn_cancel", turnId: "ghost" }),
    ).not.toThrow();
  });

  test("cancel with wrong turnId on same connection is a no-op", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    await handler.handleTurnStart(conn, {
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

describe("AcpTurnHandler — supersede + connection close", async () => {
  test("a second acp_turn_start on the same connection cancels the previous turn", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t5",
      sessionId: "s1",
      userText: "first",
    });
    const first = gw.turns[0]!;

    await handler.handleTurnStart(conn, {
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

  test("onConnectionClose cancels an in-flight turn", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    await handler.handleTurnStart(conn, {
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

  test("onConnectionClose with no active turn is a no-op", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    expect(() => handler.onConnectionClose(conn)).not.toThrow();
  });
});

describe("AcpTurnHandler — permission bridging (P8.2a)", async () => {
  test("routePermissionRequest auto-denies when no ACP turn is active", async () => {
    const gw = new StubGateway();
    const handler = new AcpTurnHandler(() => gw);

    const outcome = await handler.routePermissionRequest({
      requestId: "p1",
      toolName: "Bash",
      description: "run ls",
      inputPreview: "ls -la",
    });
    expect(outcome).toBe("deny");
  });

  test("routePermissionRequest sends acp_permission_request to the active connection", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t10",
      sessionId: "s1",
      userText: "do a thing",
    });

    const outcomePromise = handler.routePermissionRequest({
      requestId: "p2",
      toolName: "Bash",
      description: "run ls -la",
      inputPreview: "ls -la",
    });

    // Assert the frame went out to the active subprocess.
    expect(conn.sent).toEqual([
      {
        type: "acp_permission_request",
        requestId: "p2",
        turnId: "t10",
        toolName: "Bash",
        description: "run ls -la",
        inputPreview: "ls -la",
      },
    ]);

    // Simulate the subprocess returning "allow".
    handler.handlePermissionResponse(conn, {
      type: "acp_permission_response",
      requestId: "p2",
      outcome: "allow",
    });

    expect(await outcomePromise).toBe("allow");
  });

  test("handlePermissionResponse from a non-owning connection is ignored", async () => {
    const gw = new StubGateway();
    const owner = new FakeConnection();
    const other = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw, undefined, { permissionTimeoutMs: 50 });

    await handler.handleTurnStart(owner, {
      type: "acp_turn_start",
      turnId: "t11",
      sessionId: "s1",
      userText: "x",
    });

    const outcomePromise = handler.routePermissionRequest({
      requestId: "p3",
      toolName: "Bash",
      description: "x",
      inputPreview: "",
    });

    // Wrong connection tries to answer — should be ignored.
    handler.handlePermissionResponse(other, {
      type: "acp_permission_response",
      requestId: "p3",
      outcome: "allow",
    });

    // Timeout should fire → deny.
    expect(await outcomePromise).toBe("deny");
  });

  test("onConnectionClose auto-denies pending permissions from that connection", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw, undefined, { permissionTimeoutMs: 60_000 });

    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t12",
      sessionId: "s1",
      userText: "x",
    });

    const outcomePromise = handler.routePermissionRequest({
      requestId: "p4",
      toolName: "Bash",
      description: "x",
      inputPreview: "",
    });

    handler.onConnectionClose(conn);

    expect(await outcomePromise).toBe("deny");
  });

  test("permission request times out and auto-denies when no answer arrives", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw, undefined, { permissionTimeoutMs: 20 });

    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t13",
      sessionId: "s1",
      userText: "x",
    });

    const outcome = await handler.routePermissionRequest({
      requestId: "p5",
      toolName: "Bash",
      description: "x",
      inputPreview: "",
    });
    expect(outcome).toBe("deny");
  });

  test("unknown permission response is silently dropped", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    expect(() =>
      handler.handlePermissionResponse(conn, {
        type: "acp_permission_response",
        requestId: "ghost",
        outcome: "allow",
      }),
    ).not.toThrow();
  });

  test("end-to-end: ACP turn that triggers a permission prompt relays verdict and continues", async () => {
    // This test models the full chosen behavior documented in
    // architecture.md §"Permission-relay policy for ACP-originated turns":
    // an ACP turn is in flight, CC asks for a tool-use verdict, the
    // daemon routes it to the ACP subprocess, and the subprocess's
    // reply is forwarded back before the turn completes.
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw);

    // 1. ACP subprocess opens a turn.
    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "turn-e2e",
      sessionId: "sess-e2e",
      userText: "run the build",
    });

    // 2. Gateway emits an initial chunk (assistant talking).
    gw.lastTurn.emit("chunk", "planning...");

    // 3. CC asks for permission mid-turn; daemon routes via handler.
    const verdictPromise = handler.routePermissionRequest({
      requestId: "perm-e2e",
      toolName: "Bash",
      description: "run the build script",
      inputPreview: "bun run build",
    });

    // 4. Subprocess receives the permission_request frame and replies "allow"
    //    (simulating the ACP client's user clicking Allow).
    handler.handlePermissionResponse(conn, {
      type: "acp_permission_response",
      requestId: "perm-e2e",
      outcome: "allow",
    });

    expect(await verdictPromise).toBe("allow");

    // 5. Gateway finishes the turn (assistant finishes after running the tool).
    gw.lastTurn.emit("chunk", "build succeeded");
    gw.lastTurn.emit("complete");

    // The subprocess saw chunks AND the permission frame in the correct order,
    // followed by the terminal complete.
    expect(conn.sent).toEqual([
      { type: "acp_turn_chunk", turnId: "turn-e2e", text: "planning..." },
      {
        type: "acp_permission_request",
        requestId: "perm-e2e",
        turnId: "turn-e2e",
        toolName: "Bash",
        description: "run the build script",
        inputPreview: "bun run build",
      },
      { type: "acp_turn_chunk", turnId: "turn-e2e", text: "build succeeded" },
      { type: "acp_turn_complete", turnId: "turn-e2e" },
    ]);
  });
});

describe("AcpTurnHandler — target routing (P10.4)", async () => {
  test("turn is forwarded when target's CC is attached", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const attached = new Set(["claude:project-a"]);
    const handler = new AcpTurnHandler(() => gw, undefined, {
      isTargetAttached: (t) => attached.has(t),
    });

    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t-ok",
      sessionId: "s",
      userText: "hi",
      target: "claude:project-a",
    });

    expect(gw.turns).toHaveLength(1);
    gw.lastTurn.emit("chunk", "ok");
    gw.lastTurn.emit("complete");
    expect(conn.sent).toEqual([
      { type: "acp_turn_chunk", turnId: "t-ok", text: "ok" },
      { type: "acp_turn_complete", turnId: "t-ok" },
    ]);
  });

  test("turn is rejected with acp_turn_error when target is unattached", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const attached = new Set(["claude:project-a"]);
    const handler = new AcpTurnHandler(() => gw, undefined, {
      isTargetAttached: (t) => attached.has(t),
    });

    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t-ghost",
      sessionId: "s",
      userText: "hi",
      target: "claude:does-not-exist",
    });

    // Gateway was never asked to start a turn.
    expect(gw.turns).toHaveLength(0);
    // Subprocess got an explicit error frame.
    expect(conn.sent).toEqual([
      {
        type: "acp_turn_error",
        turnId: "t-ghost",
        message: "target claude:does-not-exist not attached",
      },
    ]);
  });

  test("missing target field defaults to claude:default", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const attached = new Set(["claude:default"]);
    const handler = new AcpTurnHandler(() => gw, undefined, {
      isTargetAttached: (t) => attached.has(t),
    });

    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t-default",
      sessionId: "s",
      userText: "hi",
      // No target — should resolve to claude:default and succeed.
    });

    expect(gw.turns).toHaveLength(1);
  });

  test("no isTargetAttached predicate → every target accepted (v0.1 compat)", async () => {
    const gw = new StubGateway();
    const conn = new FakeConnection();
    const handler = new AcpTurnHandler(() => gw); // no opts

    await handler.handleTurnStart(conn, {
      type: "acp_turn_start",
      turnId: "t-legacy",
      sessionId: "s",
      userText: "hi",
      target: "claude:anything",
    });

    expect(gw.turns).toHaveLength(1);
  });
});
