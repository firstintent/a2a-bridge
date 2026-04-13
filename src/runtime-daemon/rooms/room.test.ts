import { describe, test, expect } from "bun:test";
import { Room, type PeerAdapter } from "@daemon/rooms/room";
import type { ClaudeCodeGateway, ClaudeCodeTurn } from "@daemon/inbound/a2a-http/claude-code-gateway";
import { TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";
import type { RoomId } from "@daemon/rooms/room-id";

function stubGateway(): ClaudeCodeGateway {
  return {
    startTurn: () => {
      throw new Error("gateway not wired in this test");
    },
  } as unknown as ClaudeCodeGateway;
}

function stubTurn(): ClaudeCodeTurn {
  return {} as unknown as ClaudeCodeTurn;
}
// Satisfy lint: reference the import so type-only chains do not flag.
void stubTurn;

function makeAdapter(name: string, onDispose?: () => Promise<void> | void): PeerAdapter {
  return { peerName: name, dispose: onDispose };
}

describe("Room", () => {
  test("exposes id, gateway, and registry from the init block", () => {
    const registry = new TaskRegistry();
    const gateway = stubGateway();
    const room = new Room({ id: "room-1" as RoomId, gateway, registry });
    expect(room.id).toBe("room-1" as RoomId);
    expect(room.gateway).toBe(gateway);
    expect(room.registry).toBe(registry);
    expect(room.peerNames()).toEqual([]);
    expect(room.isDisposed).toBe(false);
  });

  test("attaches initial peers from the init block in order", () => {
    const room = new Room({
      id: "r" as RoomId,
      gateway: stubGateway(),
      registry: new TaskRegistry(),
      peers: [makeAdapter("codex"), makeAdapter("openclaw")],
    });
    expect(room.peerNames()).toEqual(["codex", "openclaw"]);
    expect(room.getPeer("codex")?.peerName).toBe("codex");
  });

  test("attachPeer rejects duplicate names", () => {
    const room = new Room({
      id: "r" as RoomId,
      gateway: stubGateway(),
      registry: new TaskRegistry(),
    });
    room.attachPeer(makeAdapter("codex"));
    expect(() => room.attachPeer(makeAdapter("codex"))).toThrow(/already attached/);
  });

  test("dispose() runs each peer's dispose() and clears the set", async () => {
    const disposeCalls: string[] = [];
    const room = new Room({
      id: "r" as RoomId,
      gateway: stubGateway(),
      registry: new TaskRegistry(),
      peers: [
        makeAdapter("codex", () => {
          disposeCalls.push("codex");
        }),
        makeAdapter("openclaw", async () => {
          disposeCalls.push("openclaw");
        }),
      ],
    });

    await room.dispose();
    expect(room.isDisposed).toBe(true);
    expect(disposeCalls).toEqual(["codex", "openclaw"]);
    expect(room.peerNames()).toEqual([]);
  });

  test("dispose() is idempotent", async () => {
    let count = 0;
    const room = new Room({
      id: "r" as RoomId,
      gateway: stubGateway(),
      registry: new TaskRegistry(),
      peers: [
        makeAdapter("a", () => {
          count += 1;
        }),
      ],
    });
    await room.dispose();
    await room.dispose();
    expect(count).toBe(1);
  });

  test("dispose() swallows individual adapter errors so one failure does not block the rest", async () => {
    const calls: string[] = [];
    const room = new Room({
      id: "r" as RoomId,
      gateway: stubGateway(),
      registry: new TaskRegistry(),
      peers: [
        makeAdapter("bad", () => {
          calls.push("bad");
          throw new Error("boom");
        }),
        makeAdapter("good", () => {
          calls.push("good");
        }),
      ],
    });
    await room.dispose();
    expect(calls).toEqual(["bad", "good"]);
  });

  test("attachPeer after dispose throws", async () => {
    const room = new Room({
      id: "r" as RoomId,
      gateway: stubGateway(),
      registry: new TaskRegistry(),
    });
    await room.dispose();
    expect(() => room.attachPeer(makeAdapter("late"))).toThrow(/disposed/);
  });

  test("dispose leaves the external gateway and registry untouched", async () => {
    const registry = new TaskRegistry();
    registry.create({
      id: "t",
      contextId: "c",
      kind: "task",
      status: { state: "submitted" },
    });
    const gateway = stubGateway();
    const room = new Room({ id: "r" as RoomId, gateway, registry });
    await room.dispose();
    expect(room.gateway).toBe(gateway);
    expect(room.registry).toBe(registry);
    expect(registry.get("t")).toBeDefined();
  });
});
