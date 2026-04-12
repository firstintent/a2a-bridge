import {
  JsonRpcMethodError,
  type JsonRpcHandler,
} from "@daemon/inbound/a2a-http/jsonrpc";

/**
 * A2A-reserved error code for "task not found" (the SDK's
 * `TaskNotFoundError`). Used by `tasks/get` and `tasks/cancel`.
 */
export const TASK_NOT_FOUND = -32001;

/**
 * `tasks/get` stub handler.
 *
 * Until the in-memory task registry lands (P2.13) there are no tasks
 * to fetch; every call returns a `-32001 TaskNotFound` error. The
 * `JsonRpcMethodError` path through `dispatch` emits it as a proper
 * JSON-RPC error response.
 */
export const handleTasksGet: JsonRpcHandler = (params) => {
  const id = extractTaskId(params);
  throw new JsonRpcMethodError(
    TASK_NOT_FOUND,
    id ? `Task not found: ${id}` : "Task not found",
  );
};

function extractTaskId(params: unknown): string | undefined {
  if (typeof params === "object" && params !== null && "id" in params) {
    const value = (params as { id: unknown }).id;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
