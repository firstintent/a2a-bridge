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
 * rooms/ so we depend only on this shape).
 */
export interface PeerAdapter {
  readonly name: string;
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
    if (this.peers.has(adapter.name)) {
      throw new Error(`Room ${this.id}: peer "${adapter.name}" already attached`);
    }
    this.peers.set(adapter.name, adapter);
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
   * Tear down the room: run each peer's `dispose` if present, clear
   * the adapter set, and mark the room disposed. Idempotent — a second
   * call is a no-op. Intentionally does not touch `gateway` or
   * `registry`: those are owned by the caller that passed them in.
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
  }

  private ensureLive(): void {
    if (this.disposed) {
      throw new Error(`Room ${this.id}: cannot mutate a disposed room`);
    }
  }
}
