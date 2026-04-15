/**
 * P8.1 — Control-plane wire format for ACP turns.
 *
 * Verifies:
 *  - Each new message variant round-trips through JSON serialisation.
 *  - `assertIdentifierSafeKeys` accepts valid keys and rejects unsafe ones.
 */
import { describe, test, expect } from "bun:test";
import {
  assertIdentifierSafeKeys,
  type AcpTurnMeta,
  type ControlClientMessage,
  type ControlServerMessage,
} from "@transport/control-protocol";

// ---------------------------------------------------------------------------
// Round-trip helpers
// ---------------------------------------------------------------------------

function roundtripClient(msg: ControlClientMessage): ControlClientMessage {
  return JSON.parse(JSON.stringify(msg)) as ControlClientMessage;
}

function roundtripServer(msg: ControlServerMessage): ControlServerMessage {
  return JSON.parse(JSON.stringify(msg)) as ControlServerMessage;
}

// ---------------------------------------------------------------------------
// Client → Daemon frames
// ---------------------------------------------------------------------------

describe("P10.2 control-plane: claude_connect carries optional target", () => {
  test("claude_connect with target round-trips", () => {
    const msg: ControlClientMessage = {
      type: "claude_connect",
      target: "claude:project-a",
    };
    const restored = roundtripClient(msg);
    expect(restored).toEqual(msg);
    if (restored.type === "claude_connect") {
      expect(restored.target).toBe("claude:project-a");
    }
  });

  test("claude_connect without target round-trips (v0.1 backward compat)", () => {
    const msg: ControlClientMessage = { type: "claude_connect" };
    const restored = roundtripClient(msg);
    expect(restored).toEqual(msg);
    if (restored.type === "claude_connect") {
      expect(restored.target).toBeUndefined();
    }
  });
});

describe("P10.8 control-plane: claude_to_codex carries optional target", () => {
  test("claude_to_codex with target round-trips", () => {
    const msg: ControlClientMessage = {
      type: "claude_to_codex",
      requestId: "r42",
      message: {
        id: "m1",
        source: "claude",
        content: "hand-off",
        timestamp: 1_700_000_000_000,
      },
      target: "claude:project-b",
    };
    const restored = roundtripClient(msg);
    expect(restored).toEqual(msg);
    if (restored.type === "claude_to_codex") {
      expect(restored.target).toBe("claude:project-b");
    }
  });

  test("claude_to_codex without target round-trips (v0.1 backward compat)", () => {
    const msg: ControlClientMessage = {
      type: "claude_to_codex",
      requestId: "r42",
      message: {
        id: "m1",
        source: "claude",
        content: "hand-off",
        timestamp: 1_700_000_000_000,
      },
    };
    const restored = roundtripClient(msg);
    expect(restored).toEqual(msg);
    if (restored.type === "claude_to_codex") {
      expect(restored.target).toBeUndefined();
    }
  });
});

describe("P10.6 control-plane: claude_connect force + conflict frames", () => {
  test("claude_connect with force=true round-trips", () => {
    const msg: ControlClientMessage = {
      type: "claude_connect",
      target: "claude:ws-a",
      force: true,
    };
    const restored = roundtripClient(msg);
    expect(restored).toEqual(msg);
    if (restored.type === "claude_connect") {
      expect(restored.force).toBe(true);
    }
  });

  test("claude_connect_rejected (daemon → plugin) round-trips", () => {
    const msg: ControlServerMessage = {
      type: "claude_connect_rejected",
      target: "claude:ws-a",
      reason: "target already attached (plugin conn #1)",
    };
    expect(roundtripServer(msg)).toEqual(msg);
  });

  test("claude_connect_replaced (daemon → plugin) round-trips", () => {
    const msg: ControlServerMessage = {
      type: "claude_connect_replaced",
      target: "claude:ws-a",
    };
    expect(roundtripServer(msg)).toEqual(msg);
  });
});

describe("P8.1 control-plane: ControlClientMessage ACP variants", () => {
  test("acp_turn_start round-trips with required fields", () => {
    const msg: ControlClientMessage = {
      type: "acp_turn_start",
      turnId: "t1",
      sessionId: "s1",
      userText: "hello daemon",
    };
    expect(roundtripClient(msg)).toEqual(msg);
  });

  test("acp_turn_start round-trips with optional meta", () => {
    const msg: ControlClientMessage = {
      type: "acp_turn_start",
      turnId: "t2",
      sessionId: "s2",
      userText: "with meta",
      meta: { room_id: "r1", source_type: "acp" },
    };
    const result = roundtripClient(msg);
    expect(result).toEqual(msg);
    expect((result as Extract<ControlClientMessage, { type: "acp_turn_start" }>).meta).toEqual({
      room_id: "r1",
      source_type: "acp",
    });
  });

  test("acp_turn_cancel round-trips", () => {
    const msg: ControlClientMessage = { type: "acp_turn_cancel", turnId: "t3" };
    expect(roundtripClient(msg)).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// Daemon → Client frames
// ---------------------------------------------------------------------------

describe("P8.1 control-plane: ControlServerMessage ACP variants", () => {
  test("acp_turn_chunk round-trips", () => {
    const msg: ControlServerMessage = {
      type: "acp_turn_chunk",
      turnId: "t4",
      text: "hello from CC",
    };
    expect(roundtripServer(msg)).toEqual(msg);
  });

  test("acp_turn_complete round-trips", () => {
    const msg: ControlServerMessage = { type: "acp_turn_complete", turnId: "t5" };
    expect(roundtripServer(msg)).toEqual(msg);
  });

  test("acp_turn_error round-trips", () => {
    const msg: ControlServerMessage = {
      type: "acp_turn_error",
      turnId: "t6",
      message: "gateway unavailable",
    };
    expect(roundtripServer(msg)).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// P8.2a — Permission-bridge frames
// ---------------------------------------------------------------------------

describe("P8.2a control-plane: permission bridge frames", () => {
  test("plugin_permission_request (client → daemon) round-trips", () => {
    const msg: ControlClientMessage = {
      type: "plugin_permission_request",
      requestId: "r1",
      toolName: "Bash",
      description: "run ls -la",
      inputPreview: "ls -la",
    };
    expect(roundtripClient(msg)).toEqual(msg);
  });

  test("acp_permission_response (client → daemon) round-trips", () => {
    const msg: ControlClientMessage = {
      type: "acp_permission_response",
      requestId: "r1",
      outcome: "allow",
    };
    expect(roundtripClient(msg)).toEqual(msg);
  });

  test("plugin_permission_response (daemon → client) round-trips", () => {
    const msg: ControlServerMessage = {
      type: "plugin_permission_response",
      requestId: "r1",
      outcome: "deny",
    };
    expect(roundtripServer(msg)).toEqual(msg);
  });

  test("acp_permission_request (daemon → client) round-trips", () => {
    const msg: ControlServerMessage = {
      type: "acp_permission_request",
      requestId: "r1",
      turnId: "t1",
      toolName: "Bash",
      description: "run ls -la",
      inputPreview: "ls -la",
    };
    expect(roundtripServer(msg)).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// assertIdentifierSafeKeys
// ---------------------------------------------------------------------------

describe("P8.1 assertIdentifierSafeKeys", () => {
  test("accepts a valid all-lowercase-alpha key", () => {
    expect(() => assertIdentifierSafeKeys({ room_id: "r1" })).not.toThrow();
  });

  test("accepts keys with digits and underscores", () => {
    const meta: AcpTurnMeta = { source_type: "acp", room_id_1: "x" };
    expect(() => assertIdentifierSafeKeys(meta)).not.toThrow();
  });

  test("accepts an empty meta object (no keys to validate)", () => {
    expect(() => assertIdentifierSafeKeys({})).not.toThrow();
  });

  test("rejects a key containing a hyphen", () => {
    expect(() => assertIdentifierSafeKeys({ "room-id": "r1" })).toThrow(
      /room-id.*identifier-safe/,
    );
  });

  test("rejects a key containing a dot", () => {
    expect(() => assertIdentifierSafeKeys({ "room.id": "r1" })).toThrow(
      /identifier-safe/,
    );
  });

  test("rejects a key containing an uppercase letter", () => {
    expect(() => assertIdentifierSafeKeys({ RoomId: "r1" })).toThrow(
      /identifier-safe/,
    );
  });

  test("rejects an empty-string key", () => {
    expect(() => assertIdentifierSafeKeys({ "": "r1" })).toThrow(
      /identifier-safe/,
    );
  });

  test("rejects a key with a space", () => {
    expect(() => assertIdentifierSafeKeys({ "room id": "r1" })).toThrow(
      /identifier-safe/,
    );
  });
});
