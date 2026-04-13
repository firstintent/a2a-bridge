/**
 * `ITaskStore` — the seam `message/stream`, `tasks/get`, and
 * `tasks/cancel` target. `TaskRegistry` (in-memory) and `SqliteTaskLog`
 * (persistent) both satisfy it so the daemon can swap transparently.
 *
 * The contract is narrow on purpose: create, read, status-update,
 * cancel, plus an EventEmitter-style `on('cancel')` / `off('cancel')`
 * hook the active SSE stream listens on to deliver its terminal frame.
 * Deletion and listing are implementation-specific — the store layer
 * does not guarantee either on every implementation.
 */

import type { RoomId } from "@daemon/rooms/room-id";

export interface TaskStatus {
  state: string;
  /** A2A `Message` payload the client treats as the terminal narrative. */
  message?: unknown;
}

export interface InitialTask {
  id: string;
  contextId: string;
  kind: "task";
  status: TaskStatus;
  /** Optional room id; stores that track rooms should default to `"default"`. */
  roomId?: RoomId;
}

export interface TaskSnapshot {
  id: string;
  contextId: string;
  kind: "task";
  status: TaskStatus;
}

export type TaskStoreCancelListener = (taskId: string) => void;

export interface ITaskStore {
  create(task: InitialTask): void;
  get(id: string): TaskSnapshot | undefined;
  updateStatus(id: string, status: TaskStatus): void;
  cancel(id: string): TaskSnapshot | undefined;
  on(event: "cancel", listener: TaskStoreCancelListener): this;
  off(event: "cancel", listener: TaskStoreCancelListener): this;
}
