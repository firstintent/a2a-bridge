import {
  JsonRpcMethodError,
  type JsonRpcHandler,
} from "@daemon/inbound/a2a-http/jsonrpc";
import type { TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";

/**
 * A2A-reserved error code for "task not found" (the SDK's
 * `TaskNotFoundError`). Used by `tasks/get` and `tasks/cancel`.
 */
export const TASK_NOT_FOUND = -32001;

/**
 * Build the `tasks/get` handler bound to a TaskRegistry.
 *
 * When no registry is supplied, every call surfaces the
 * `-32001 TaskNotFound` error — the P2.12 stub behavior, preserved so
 * early wiring (e.g. server boot before the registry instance is ready)
 * still reports the spec-accurate code instead of crashing.
 */
export function createTasksGetHandler(registry?: TaskRegistry): JsonRpcHandler {
  return (params) => {
    const id = extractTaskId(params);
    if (!id) {
      throw new JsonRpcMethodError(TASK_NOT_FOUND, "Task not found");
    }
    const task = registry?.get(id);
    if (!task) {
      throw new JsonRpcMethodError(TASK_NOT_FOUND, `Task not found: ${id}`);
    }
    return task;
  };
}

/**
 * Back-compat alias preserving the P2.12 registry-less signature so
 * call sites that hadn't plugged in the registry yet still resolve.
 */
export const handleTasksGet: JsonRpcHandler = createTasksGetHandler();

function extractTaskId(params: unknown): string | undefined {
  if (typeof params === "object" && params !== null && "id" in params) {
    const value = (params as { id: unknown }).id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
