/**
 * `Room` groups the per-session state the daemon routes to: the
 * Claude Code gateway that turns text into CC replies, a task
 * registry that the A2A inbound surface writes into, and an adapter
 * set for outbound peers.
 *
 * Each Room is independent: two Rooms never share a gateway or a
 * registry. RoomRouter (P4.3) owns the `Map<RoomId, Room>` and is
 * the only place that constructs Rooms. Callers who want to go from
 * an inbound request to its Room go through the router.
 */

import type { ClaudeCodeGateway } from "@daemon/inbound/a2a-http/claude-code-gateway";
import type { ITaskStore } from "@daemon/tasks/task-store";
import type { RoomId } from "@daemon/rooms/room-id";

/**
 * Minimum contract every peer adapter must satisfy for Room's
 * lifecycle logic (lint:deps keeps concrete adapter imports out of
 * rooms/ so we depend only on this shape). Matches the `peerName`
 * field on `IPeerAdapter`; concrete adapters (CodexAdapter,
 * OpenClawAdapter, ...) already expose it.
 *
 * `dispose` is optional; `stop()` / `close()` aliases are fine on
 * adapters, but the Room's teardown path only ever calls `dispose`.
 * `turnInProgress` is optional too — adapters that have no concept of
 * a turn (or haven't wired one yet) default to "idle" from the Room's
 * perspective.
 */
export interface PeerAdapter {
  readonly peerName: string;
  readonly turnInProgress?: boolean;
  dispose?: () => Promise<void> | void;
}

export interface RoomInit {
  id: RoomId;
  gateway: ClaudeCodeGateway;
  registry: ITaskStore;
  /** Initial adapter set. Further adapters may be attached later. */
  peers?: PeerAdapter[];
}

export class Room {
  readonly id: RoomId;
  readonly gateway: ClaudeCodeGateway;
  readonly registry: ITaskStore;
  private readonly peers: Map<string, PeerAdapter> = new Map();
  private disposed = false;

  constructor(init: RoomInit) {
    this.id = init.id;
    this.gateway = init.gateway;
    this.registry = init.registry;
    for (const adapter of init.peers ?? []) this.attachPeer(adapter);
  }

  /** Register an outbound peer adapter under this room. Names must be unique. */
  attachPeer(adapter: PeerAdapter): void {
    this.ensureLive();
    if (this.peers.has(adapter.peerName)) {
      throw new Error(`Room ${this.id}: peer "${adapter.peerName}" already attached`);
    }
    this.peers.set(adapter.peerName, adapter);
  }

  /** Return the attached adapter, or undefined if none was registered under the name. */
  getPeer(name: string): PeerAdapter | undefined {
    return this.peers.get(name);
  }

  /** Snapshot of attached adapter names; order is insertion order. */
  peerNames(): string[] {
    return Array.from(this.peers.keys());
  }

  /** True once `dispose()` has run. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * The Room is idle when no attached peer adapter has a turn in flight
   * and the caller-provided registry has no tasks scoped to this room.
   * Used by the daemon's idle-shutdown gate (P4.9): the daemon only
   * stops when every Room is idle.
   */
  get isIdle(): boolean {
    if (this.disposed) return true;
    for (const adapter of this.peers.values()) {
      if (adapter.turnInProgress) return false;
    }
    if (this.registry.listByRoom(this.id).length > 0) return false;
    return true;
  }

  /**
   * Tear down the room: run each peer's `dispose` if present, clear
   * the adapter set, purge this room's tasks from the store, and mark
   * the room disposed. Idempotent — a second call is a no-op. Does not
   * close the caller-owned gateway or the shared store (the store is
   * typically daemon-wide and survives individual Room disposals).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const adapters = Array.from(this.peers.values());
    this.peers.clear();
    for (const adapter of adapters) {
      if (!adapter.dispose) continue;
      try {
        await adapter.dispose();
      } catch {
        // Swallow individual adapter disposal errors so one bad actor
        // cannot block the rest; the caller can inspect logs.
      }
    }
    try {
      this.registry.deleteByRoom(this.id);
    } catch {
      // Store-level errors (e.g. sqlite closed) shouldn't cascade into
      // the caller's disposal path.
    }
  }

  private ensureLive(): void {
    if (this.disposed) {
      throw new Error(`Room ${this.id}: cannot mutate a disposed room`);
    }
  }
}
