import { EventEmitter } from "node:events";
import type {
  ITaskStore,
  InitialTask,
  TaskSnapshot,
  TaskStatus as ITaskStatus,
} from "@daemon/tasks/task-store";
import type { RoomId } from "@daemon/rooms/room-id";

/**
 * In-memory `ITaskStore` implementation. Paired with `SqliteTaskLog`
 * for the persistent variant — both satisfy the same interface so the
 * A2A handlers swap transparently.
 *
 * Scope is one registry per running A2A service instance.
 * `message/stream` calls `create()` when it mints a new task;
 * `tasks/get` reads through this; `tasks/cancel` flips `state` to
 * `canceled` and emits a `cancel` event that the active SSE stream
 * listens for so it can deliver the terminal frame to the client.
 */

export type TaskStatus = ITaskStatus;

export type Task = TaskSnapshot;

interface TaskRegistryEvents {
  cancel: [taskId: string];
}

export class TaskRegistry extends EventEmitter<TaskRegistryEvents> implements ITaskStore {
  private readonly tasks = new Map<string, Task>();

  /** Register a freshly-minted task. Throws if the id is already present. */
  create(task: InitialTask): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`TaskRegistry: task ${task.id} already registered`);
    }
    // Store the caller's object so referential checks in tests still hold.
    // Extra fields (e.g. roomId from the InitialTask shape) are ignored at
    // the TaskSnapshot type boundary and remain as harmless extras at
    // runtime.
    this.tasks.set(task.id, task as Task);
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

  /**
   * All tasks whose stored input carried the given roomId. Returns an
   * empty list when no tasks match or the registry was fed tasks
   * without the optional `roomId` field.
   */
  listByRoom(roomId: RoomId): TaskSnapshot[] {
    const out: TaskSnapshot[] = [];
    for (const task of this.tasks.values()) {
      if ((task as InitialTask).roomId === roomId) out.push(task);
    }
    return out;
  }

  /** Drop every task tagged with `roomId`. Returns the count removed. */
  deleteByRoom(roomId: RoomId): number {
    let removed = 0;
    for (const [id, task] of this.tasks.entries()) {
      if ((task as InitialTask).roomId === roomId) {
        this.tasks.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Current task count. Useful for tests / diagnostics. */
  get size(): number {
    return this.tasks.size;
  }
}
