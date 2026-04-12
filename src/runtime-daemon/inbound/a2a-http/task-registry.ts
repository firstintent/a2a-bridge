import { EventEmitter } from "node:events";

/**
 * In-memory store of live A2A tasks.
 *
 * Scope is one registry per running A2A service instance. SQLite-backed
 * persistence lands in Phase 4 alongside `RoomRouter`; until then we
 * accept that tasks are lost on daemon restart — the P2 ship criterion
 * (a Gemini CLI driving a single CC session) does not require history
 * survival.
 *
 * `message/stream` calls `create()` when it mints a new task;
 * `tasks/get` reads through this; `tasks/cancel` flips `state` to
 * `canceled` and emits a `cancel` event that the active SSE stream
 * listens for so it can deliver the terminal frame to the client.
 */

export interface TaskStatus {
  state: string;
  /** A2A `Message` payload the client treats as the terminal narrative. */
  message?: unknown;
}

export interface Task {
  id: string;
  contextId: string;
  kind: "task";
  status: TaskStatus;
}

interface TaskRegistryEvents {
  cancel: [taskId: string];
}

export class TaskRegistry extends EventEmitter<TaskRegistryEvents> {
  private readonly tasks = new Map<string, Task>();

  /** Register a freshly-minted task. Throws if the id is already present. */
  create(task: Task): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`TaskRegistry: task ${task.id} already registered`);
    }
    this.tasks.set(task.id, task);
  }

  /** Return the current task snapshot, or undefined if it was never registered. */
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** Replace the task's status snapshot in-place. No-op if the task is gone. */
  updateStatus(id: string, status: TaskStatus): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = status;
  }

  /**
   * Mark the task canceled and fire the `cancel` event so an active
   * stream can emit its terminal frame. Returns the updated task or
   * undefined when the id is unknown.
   */
  cancel(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    task.status = { state: "canceled" };
    this.emit("cancel", id);
    return task;
  }

  /** Forget a task. Used by streams to release finished entries. */
  delete(id: string): void {
    this.tasks.delete(id);
  }

  /** Current task count. Useful for tests / diagnostics. */
  get size(): number {
    return this.tasks.size;
  }
}
