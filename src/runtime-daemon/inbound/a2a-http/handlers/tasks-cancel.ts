import {
  JsonRpcMethodError,
  type JsonRpcHandler,
} from "@daemon/inbound/a2a-http/jsonrpc";
import type { ITaskStore } from "@daemon/tasks/task-store";
import { TASK_NOT_FOUND } from "@daemon/inbound/a2a-http/handlers/tasks-get";

/**
 * Build the `tasks/cancel` handler bound to an `ITaskStore`.
 *
 * Cancellation semantics:
 * - Unknown task id → `-32001 TaskNotFound`, matching `tasks/get`.
 * - Known id → store.cancel() flips the task's state and fires a
 *   `cancel` event that the active `message/stream` handler uses to
 *   emit its terminal SSE frame to the client.
 * - The handler's return value is the post-cancellation Task snapshot,
 *   the same payload shape A2A's `tasks/cancel` response advertises.
 */
export function createTasksCancelHandler(registry: ITaskStore): JsonRpcHandler {
  return (params) => {
    const id = extractTaskId(params);
    if (!id) {
      throw new JsonRpcMethodError(TASK_NOT_FOUND, "Task not found");
    }
    const canceled = registry.cancel(id);
    if (!canceled) {
      throw new JsonRpcMethodError(TASK_NOT_FOUND, `Task not found: ${id}`);
    }
    return canceled;
  };
}

function extractTaskId(params: unknown): string | undefined {
  if (typeof params === "object" && params !== null && "id" in params) {
    const value = (params as { id: unknown }).id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
