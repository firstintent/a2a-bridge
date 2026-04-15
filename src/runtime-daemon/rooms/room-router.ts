/**
 * `RoomRouter` owns the `Map<RoomId, Room>` that lets inbound surfaces
 * pick up or spawn a Room on demand.
 *
 * Construction is deferred to the caller via `roomFactory(id)` so the
 * router stays transport-agnostic — the daemon wires one factory that
 * knows how to build a Room's gateway, registry, and initial peer set.
 *
 * `getOrCreate` is the hot path: inbound calls `deriveRoomId(...)` to
 * get the key, then `getOrCreate(key)` to reach the Room. `dispose`
 * is the teardown path; it drops the entry from the map *before*
 * awaiting `Room.dispose()` so a slow adapter shutdown cannot block
 * a concurrent getOrCreate from minting a fresh Room for the same id.
 */

import { Room } from "@daemon/rooms/room";
import type { RoomId } from "@daemon/rooms/room-id";
import type { TargetId } from "@shared/target-id";

export type RoomFactory = (id: RoomId) => Room | Promise<Room>;

export class RoomRouter {
  private readonly rooms: Map<RoomId, Room> = new Map();
  private readonly pending: Map<RoomId, Promise<Room>> = new Map();
  private readonly factory: RoomFactory;
  private disposed = false;

  constructor(factory: RoomFactory) {
    this.factory = factory;
  }

  /**
   * Return the existing Room for `id`, or mint a fresh one via the
   * factory and cache it. Concurrent calls for the same id share a
   * single factory invocation.
   */
  async getOrCreate(id: RoomId): Promise<Room> {
    this.ensureLive();
    const cached = this.rooms.get(id);
    if (cached && !cached.isDisposed) return cached;

    const inflight = this.pending.get(id);
    if (inflight) return inflight;

    const build = (async () => {
      const room = await this.factory(id);
      this.rooms.set(id, room);
      return room;
    })().finally(() => {
      this.pending.delete(id);
    });
    this.pending.set(id, build);
    return build;
  }

  /** Current Room for `id`, without creating one. */
  get(id: RoomId): Room | undefined {
    return this.rooms.get(id);
  }

  /**
   * Convenience for the v0.2 multi-target router (P10.3): a TargetId
   * is a `kind:id` string and is also a valid RoomId, so we just
   * forward to `getOrCreate`. Type-clarifying alias — call sites
   * carrying a TargetId can use this instead of casting.
   */
  async getOrCreateByTarget(target: TargetId): Promise<Room> {
    return this.getOrCreate(target as unknown as RoomId);
  }

  /** TargetId-typed accessor; returns undefined when no Room exists yet. */
  getByTarget(target: TargetId): Room | undefined {
    return this.rooms.get(target as unknown as RoomId);
  }

  /**
   * Seed the router with a pre-built Room so subsequent `getOrCreate(id)`
   * calls return it without re-invoking the factory. Throws if a Room is
   * already cached for `room.id` — seeding is only appropriate at boot.
   */
  adopt(room: Room): void {
    this.ensureLive();
    if (this.rooms.has(room.id)) {
      throw new Error(`RoomRouter: room ${room.id} already adopted`);
    }
    this.rooms.set(room.id, room);
  }

  /** Snapshot count of live Rooms. */
  get size(): number {
    return this.rooms.size;
  }

  /**
   * True when every live Room reports `isIdle`. The daemon's
   * idle-shutdown path gates on this so it only stops when no room is
   * mid-turn and no room has outstanding tasks (P4.9).
   */
  get allIdle(): boolean {
    for (const room of this.rooms.values()) {
      if (!room.isIdle) return false;
    }
    return true;
  }

  /** Drop `id` from the map and dispose the Room. No-op when absent. */
  async dispose(id: RoomId): Promise<void> {
    const room = this.rooms.get(id);
    if (!room) return;
    this.rooms.delete(id);
    await room.dispose();
  }

  /** Tear down every live Room. Router becomes unusable afterwards. */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    const rooms = Array.from(this.rooms.values());
    this.rooms.clear();
    for (const room of rooms) {
      try {
        await room.dispose();
      } catch {
        // Swallow to keep disposal best-effort. Individual Room.dispose
        // already tolerates per-adapter failures; this is only for the
        // (rarer) case where dispose itself throws.
      }
    }
  }

  private ensureLive(): void {
    if (this.disposed) {
      throw new Error("RoomRouter: cannot use a router after disposeAll()");
    }
  }
}
