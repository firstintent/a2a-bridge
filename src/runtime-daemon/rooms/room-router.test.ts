import { describe, test, expect } from "bun:test";
import { Room } from "@daemon/rooms/room";
import { RoomRouter } from "@daemon/rooms/room-router";
import type { RoomId } from "@daemon/rooms/room-id";
import type { ClaudeCodeGateway } from "@daemon/inbound/a2a-http/claude-code-gateway";
import { TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";

function stubGateway(): ClaudeCodeGateway {
  return {
    startTurn: () => {
      throw new Error("gateway not wired in this test");
    },
  } as unknown as ClaudeCodeGateway;
}

function defaultFactory() {
  const calls: RoomId[] = [];
  const factory = (id: RoomId) => {
    calls.push(id);
    return new Room({ id, gateway: stubGateway(), registry: new TaskRegistry() });
  };
  return { factory, calls };
}

describe("RoomRouter", () => {
  test("getOrCreate mints a Room on first call and caches it", async () => {
    const { factory, calls } = defaultFactory();
    const router = new RoomRouter(factory);
    expect(router.size).toBe(0);

    const first = await router.getOrCreate("room-a" as RoomId);
    expect(first.id).toBe("room-a" as RoomId);
    expect(router.size).toBe(1);
    expect(calls).toEqual(["room-a"] as RoomId[]);

    const second = await router.getOrCreate("room-a" as RoomId);
    expect(second).toBe(first);
    expect(calls).toEqual(["room-a"] as RoomId[]);
  });

  test("getOrCreate serves distinct ids from distinct Rooms", async () => {
    const { factory } = defaultFactory();
    const router = new RoomRouter(factory);
    const a = await router.getOrCreate("a" as RoomId);
    const b = await router.getOrCreate("b" as RoomId);
    expect(a).not.toBe(b);
    expect(router.size).toBe(2);
  });

  test("concurrent getOrCreate for the same id collapses into one factory call", async () => {
    let factoryCalls = 0;
    let resolveRoom!: (room: Room) => void;
    const factory = (id: RoomId) =>
      new Promise<Room>((resolve) => {
        factoryCalls += 1;
        resolveRoom = (room) => resolve(room);
        void id;
      });
    const router = new RoomRouter(factory);
    const pA = router.getOrCreate("shared" as RoomId);
    const pB = router.getOrCreate("shared" as RoomId);
    // Resolve the single inflight factory; both awaiters must observe it.
    resolveRoom(
      new Room({
        id: "shared" as RoomId,
        gateway: stubGateway(),
        registry: new TaskRegistry(),
      }),
    );
    const [roomA, roomB] = await Promise.all([pA, pB]);
    expect(roomA).toBe(roomB);
    expect(factoryCalls).toBe(1);
    expect(router.size).toBe(1);
  });

  test("dispose(id) removes the Room from the map and calls Room.dispose()", async () => {
    let disposed = false;
    const factory = (id: RoomId) => {
      const room = new Room({
        id,
        gateway: stubGateway(),
        registry: new TaskRegistry(),
        peers: [
          {
            peerName: "p",
            dispose: () => {
              disposed = true;
            },
          },
        ],
      });
      return room;
    };
    const router = new RoomRouter(factory);
    await router.getOrCreate("r" as RoomId);
    expect(router.size).toBe(1);
    await router.dispose("r" as RoomId);
    expect(router.size).toBe(0);
    expect(disposed).toBe(true);
    expect(router.get("r" as RoomId)).toBeUndefined();
  });

  test("dispose(id) is a no-op for unknown ids", async () => {
    const { factory } = defaultFactory();
    const router = new RoomRouter(factory);
    await router.dispose("nonexistent" as RoomId);
    expect(router.size).toBe(0);
  });

  test("after dispose, a subsequent getOrCreate mints a fresh Room", async () => {
    const { factory, calls } = defaultFactory();
    const router = new RoomRouter(factory);
    const first = await router.getOrCreate("r" as RoomId);
    await router.dispose("r" as RoomId);
    const second = await router.getOrCreate("r" as RoomId);
    expect(second).not.toBe(first);
    expect(calls).toEqual(["r", "r"] as RoomId[]);
  });

  test("disposeAll tears down every Room and rejects further getOrCreate", async () => {
    const disposed: RoomId[] = [];
    const factory = (id: RoomId) =>
      new Room({
        id,
        gateway: stubGateway(),
        registry: new TaskRegistry(),
        peers: [{ peerName: "p", dispose: () => void disposed.push(id) }],
      });
    const router = new RoomRouter(factory);
    await router.getOrCreate("a" as RoomId);
    await router.getOrCreate("b" as RoomId);
    await router.disposeAll();
    expect(router.size).toBe(0);
    expect(disposed.sort()).toEqual(["a", "b"] as RoomId[]);
    await expect(router.getOrCreate("c" as RoomId)).rejects.toThrow(/disposeAll/);
  });
});
