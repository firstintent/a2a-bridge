/**
 * JSON-RPC 2.0 dispatcher for the non-streaming A2A methods.
 *
 * The `message/stream` handler is separate — SSE responses do not fit
 * the single-response shape this dispatcher returns. Everything else
 * the A2A SDK calls (`tasks/get`, `tasks/cancel`) is a simple
 * request-response dance that routes cleanly through `dispatch`.
 *
 * Per spec:
 *   -32700  Parse error         (invalid JSON)
 *   -32600  Invalid Request     (not a conforming JSON-RPC shape)
 *   -32601  Method not found
 *   -32603  Internal error      (handler threw)
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: JsonRpcId;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  result: unknown;
  id: JsonRpcId;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  error: JsonRpcError;
  id: JsonRpcId;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export type JsonRpcHandler = (
  params: unknown,
  request: JsonRpcRequest,
) => Promise<unknown> | unknown;

export type JsonRpcHandlers = Record<string, JsonRpcHandler>;

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Parse + validate + route a single JSON-RPC 2.0 request.
 *
 * Returns the response object to emit, or `null` if the input was a
 * valid notification (no `id` field) — in which case the caller should
 * reply with `204 No Content`.
 *
 * Parse errors and framing errors on requests that don't look like
 * notifications produce a response with `id: null`, matching the spec.
 */
export async function dispatch(
  raw: string,
  handlers: JsonRpcHandlers,
): Promise<JsonRpcResponse | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(null, JSON_RPC_ERRORS.PARSE_ERROR, "Parse error");
  }

  if (!isPlainObject(parsed)) {
    return errorResponse(null, JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request");
  }

  const isNotification = !("id" in parsed);
  const id: JsonRpcId = isNotification
    ? null
    : normalizeId((parsed as { id?: unknown }).id);

  if ((parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    return isNotification
      ? null
      : errorResponse(id, JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request: jsonrpc must be \"2.0\"");
  }

  const method = (parsed as { method?: unknown }).method;
  if (typeof method !== "string" || method.length === 0) {
    return isNotification
      ? null
      : errorResponse(id, JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid Request: method must be a non-empty string");
  }

  const handler = handlers[method];
  if (!handler) {
    return isNotification
      ? null
      : errorResponse(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
    params: (parsed as { params?: unknown }).params,
    id,
  };

  try {
    const result = await handler(request.params, request);
    return isNotification
      ? null
      : { jsonrpc: "2.0", result: result ?? null, id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return isNotification
      ? null
      : errorResponse(id, JSON_RPC_ERRORS.INTERNAL_ERROR, `Internal error: ${message}`);
  }
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    error: data === undefined ? { code, message } : { code, message, data },
    id,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeId(id: unknown): JsonRpcId {
  if (id === null) return null;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}
