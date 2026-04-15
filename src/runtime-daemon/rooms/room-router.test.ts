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

  test("adopt seeds a pre-built room so getOrCreate returns it without reinvoking the factory", async () => {
    const { factory, calls } = defaultFactory();
    const router = new RoomRouter(factory);
    const seeded = new Room({
      id: "adopted" as RoomId,
      gateway: stubGateway(),
      registry: new TaskRegistry(),
    });
    router.adopt(seeded);
    expect(router.size).toBe(1);
    expect(router.get("adopted" as RoomId)).toBe(seeded);
    const observed = await router.getOrCreate("adopted" as RoomId);
    expect(observed).toBe(seeded);
    expect(calls).toEqual([] as RoomId[]);
  });

  test("adopt rejects a duplicate id", () => {
    const { factory } = defaultFactory();
    const router = new RoomRouter(factory);
    const first = new Room({
      id: "dup" as RoomId,
      gateway: stubGateway(),
      registry: new TaskRegistry(),
    });
    router.adopt(first);
    expect(() =>
      router.adopt(
        new Room({
          id: "dup" as RoomId,
          gateway: stubGateway(),
          registry: new TaskRegistry(),
        }),
      ),
    ).toThrow(/already adopted/);
  });

  test("allIdle is true only when every room reports idle", async () => {
    const registry = new TaskRegistry();
    const router = new RoomRouter(
      (id) =>
        new Room({
          id,
          gateway: stubGateway(),
          registry,
        }),
    );
    const roomA = await router.getOrCreate("a" as RoomId);
    await router.getOrCreate("b" as RoomId);
    expect(router.allIdle).toBe(true);

    // Queue a task for roomA — router no longer idle.
    registry.create({
      id: "t1",
      contextId: "c",
      kind: "task",
      status: { state: "submitted" },
      roomId: roomA.id,
    });
    expect(router.allIdle).toBe(false);

    registry.delete("t1");
    expect(router.allIdle).toBe(true);
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

  // ------------------------------------------------------------------
  // P10.3 — getOrCreateByTarget / getByTarget
  // ------------------------------------------------------------------

  test("getOrCreateByTarget mints a Room keyed by the TargetId string", async () => {
    const { factory, calls } = defaultFactory();
    const router = new RoomRouter(factory);

    const room = await router.getOrCreateByTarget(
      "claude:project-a" as unknown as import("@shared/target-id").TargetId,
    );
    expect(room.id).toBe("claude:project-a" as RoomId);
    expect(calls).toEqual(["claude:project-a"] as RoomId[]);

    // Same target → same Room (no factory re-call).
    const again = await router.getOrCreateByTarget(
      "claude:project-a" as unknown as import("@shared/target-id").TargetId,
    );
    expect(again).toBe(room);
    expect(calls).toEqual(["claude:project-a"] as RoomId[]);
  });

  test("getByTarget returns existing Room without minting", async () => {
    const { factory } = defaultFactory();
    const router = new RoomRouter(factory);

    expect(
      router.getByTarget(
        "claude:default" as unknown as import("@shared/target-id").TargetId,
      ),
    ).toBeUndefined();

    await router.getOrCreateByTarget(
      "claude:default" as unknown as import("@shared/target-id").TargetId,
    );
    const found = router.getByTarget(
      "claude:default" as unknown as import("@shared/target-id").TargetId,
    );
    expect(found).toBeDefined();
    expect(found?.id).toBe("claude:default" as RoomId);
  });

  test("different targets get separate Rooms", async () => {
    const { factory, calls } = defaultFactory();
    const router = new RoomRouter(factory);

    const a = await router.getOrCreateByTarget(
      "claude:proj-a" as unknown as import("@shared/target-id").TargetId,
    );
    const b = await router.getOrCreateByTarget(
      "claude:proj-b" as unknown as import("@shared/target-id").TargetId,
    );

    expect(a).not.toBe(b);
    expect(router.size).toBe(2);
    expect(calls.sort()).toEqual(["claude:proj-a", "claude:proj-b"] as RoomId[]);
  });
});
