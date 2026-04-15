import { createLogger, type Logger } from "@shared/logger";
import { parseTarget, type TargetId } from "@shared/target-id";
import { AGENT_CARD_PATH, checkBearerAuth } from "@daemon/inbound/a2a-http/auth";
import {
  buildAgentCard,
  type AgentCard,
  type AgentCardConfig,
} from "@daemon/inbound/a2a-http/agent-card";
import {
  dispatch,
  JSON_RPC_ERRORS,
  type JsonRpcHandlers,
  type JsonRpcResponse,
} from "@daemon/inbound/a2a-http/jsonrpc";
import type { ITaskStore } from "@daemon/tasks/task-store";
import { SqliteTaskLog } from "@daemon/tasks/task-log";
import type { RoomRouter } from "@daemon/rooms/room-router";
import { deriveRoomId, type RoomId } from "@daemon/rooms/room-id";
import type { ClaudeCodeGateway } from "@daemon/inbound/a2a-http/claude-code-gateway";
import {
  createEchoExecutor,
  handleMessageStream,
  type MessageStreamExecutor,
  type MessageStreamParams,
} from "@daemon/inbound/a2a-http/handlers/message-stream";
import { createTasksGetHandler } from "@daemon/inbound/a2a-http/handlers/tasks-get";
import { createTasksCancelHandler } from "@daemon/inbound/a2a-http/handlers/tasks-cancel";

/** Fallback TargetId when contextRoutes is supplied but the inbound contextId has no mapping. */
const A2A_FALLBACK_TARGET = "claude:default";

/**
 * A2A-over-HTTP server.
 *
 * Binds Bun.serve, serves /healthz, the agent card at
 * /.well-known/agent-card.json, and routes POSTs on the RPC path
 * (derived from `agentCard.url`) through bearer auth into either the
 * `message/stream` SSE handler or the JSON-RPC dispatcher for
 * `tasks/get` / `tasks/cancel` / any caller-supplied extras.
 */

export interface A2aServerConfig {
  /** Hostname or IP to bind; defaults to 127.0.0.1. */
  host?: string;
  /** TCP port to bind. */
  port: number;
  /** Agent card config passed through to `buildAgentCard`. */
  agentCard: AgentCardConfig;
  /** Bearer token required on the JSON-RPC endpoint. */
  bearerToken: string;
  /** When true, the agent-card endpoint is exempt from bearer auth. */
  publicAgentCard?: boolean;
  /**
   * Executor that drives `message/stream`. Defaults to `createEchoExecutor`
   * so the server is usable in smoke tests before a peer is wired.
   * Ignored when `roomRouter` is supplied — routing picks a per-room
   * executor through `executorFactory` instead.
   */
  messageStreamExecutor?: MessageStreamExecutor;
  /**
   * When supplied, every inbound `message/stream` turn is routed through
   * the router: the room id comes from `deriveRoomId({ contextId, env })`,
   * and the room's `ClaudeCodeGateway` feeds `executorFactory` to build
   * the per-request executor. ACP inbound (P5) takes the same router.
   */
  roomRouter?: RoomRouter;
  /**
   * Builds a `MessageStreamExecutor` from the selected room's gateway.
   * Required when `roomRouter` is supplied; ignored otherwise.
   */
  executorFactory?: (gateway: ClaudeCodeGateway) => MessageStreamExecutor;
  /**
   * P10.7 — `contextId → TargetId` routing map. When supplied, every
   * inbound `message/stream` turn resolves its target by looking up
   * its `contextId` in this map; unmapped contexts fall back to
   * `claude:default`. The resolved TargetId keys the Room (via
   * `RoomRouter.getOrCreateByTarget`) so multi-CC deployments can
   * carve A2A traffic across distinct CC instances.
   *
   * Omitted (or absent/empty) → server preserves v0.1 behaviour where
   * `deriveRoomId({ contextId })` keys each contextId as its own Room.
   * Requires `roomRouter`; the server throws at startup otherwise.
   * Every value is validated via `parseTarget` — a bad entry is a
   * configuration error, not a runtime failure.
   */
  contextRoutes?: Record<string, string>;
  /**
   * Shared task store. Callers supply an `ITaskStore` (either the
   * in-memory `TaskRegistry` or a `SqliteTaskLog`); when omitted a
   * `SqliteTaskLog` opens at `taskLogPath` (or `":memory:"` when that's
   * also absent) so tests don't require a state-dir.
   */
  registry?: ITaskStore;
  /**
   * Path passed to `SqliteTaskLog.open()` when `registry` is omitted.
   * Default `":memory:"` keeps unit tests ephemeral; `daemon.ts` passes
   * `stateDir.taskLogFile` for persistent behaviour.
   */
  taskLogPath?: string;
  /**
   * Extra non-streaming JSON-RPC handlers, merged with the built-in
   * tasks/* handlers. Caller handlers override on name clash.
   */
  extraHandlers?: JsonRpcHandlers;
  /** Optional log file path; when set, request log lines are tee'd there. */
  logFilePath?: string;
  /** Override the internal logger; mainly for tests. */
  logger?: Logger;
}

export interface A2aServerHandle {
  readonly host: string;
  readonly port: number;
  readonly rpcPath: string;
  shutdown(): Promise<void>;
}

export async function startA2AServer(config: A2aServerConfig): Promise<A2aServerHandle> {
  const host = config.host ?? "127.0.0.1";
  const log =
    config.logger ?? createLogger({ tag: "A2aHttpServer", filePath: config.logFilePath });

  const card: AgentCard = buildAgentCard(config.agentCard);
  const rpcPath = extractPath(card.url);
  const registry: ITaskStore =
    config.registry ?? SqliteTaskLog.open(config.taskLogPath ?? ":memory:");
  const defaultExecutor = config.messageStreamExecutor ?? createEchoExecutor();
  const roomRouter = config.roomRouter;
  const executorFactory = config.executorFactory;
  if (roomRouter && !executorFactory) {
    throw new Error(
      "startA2AServer: roomRouter requires executorFactory so each per-room gateway can drive its own message/stream executor",
    );
  }

  // P10.7 — validate contextRoutes at startup so a typo in the config
  // surfaces immediately instead of 5xx-ing on the first inbound call.
  const contextRoutes = config.contextRoutes;
  const hasRoutes = contextRoutes !== undefined && Object.keys(contextRoutes).length > 0;
  if (hasRoutes && !roomRouter) {
    throw new Error(
      "startA2AServer: contextRoutes requires roomRouter — multi-target routing needs a Room registry to dispatch into",
    );
  }
  if (contextRoutes) {
    for (const [ctxId, target] of Object.entries(contextRoutes)) {
      const parsed = parseTarget(target);
      if (!parsed.ok) {
        throw new Error(
          `startA2AServer: contextRoutes[${JSON.stringify(ctxId)}] = "${target}" is not a valid TargetId (${parsed.error})`,
        );
      }
    }
  }

  const handlers: JsonRpcHandlers = {
    "tasks/get": createTasksGetHandler(registry),
    "tasks/cancel": createTasksCancelHandler(registry),
    ...(config.extraHandlers ?? {}),
  };

  const authConfig = {
    bearerToken: config.bearerToken,
    publicAgentCard: config.publicAgentCard === true,
  };

  const server = Bun.serve({
    port: config.port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      log(`${req.method} ${url.pathname}`);

      if (url.pathname === "/healthz") {
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }

      if (url.pathname === AGENT_CARD_PATH) {
        const denied = checkBearerAuth(req, authConfig);
        if (denied) return denied;
        return new Response(JSON.stringify(card), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (req.method === "POST" && url.pathname === rpcPath) {
        const denied = checkBearerAuth(req, authConfig);
        if (denied) return denied;

        const body = await req.text();

        // Peek at method name to decide SSE vs JSON-RPC. Malformed
        // bodies fall through to dispatch() which produces a
        // spec-correct parse-error response.
        let methodName: string | undefined;
        let rpcId: unknown = null;
        try {
          const peek = JSON.parse(body) as { method?: unknown; id?: unknown };
          if (typeof peek.method === "string") methodName = peek.method;
          rpcId = peek.id ?? null;
        } catch {
          /* fall through to dispatch */
        }

        if (methodName === "message/stream") {
          const params = extractParams(body);
          let requestExecutor: MessageStreamExecutor = defaultExecutor;
          let resolvedRoomId: RoomId | undefined;
          if (roomRouter && executorFactory) {
            if (hasRoutes && contextRoutes) {
              // P10.7 — resolve contextId → TargetId via the operator
              // config, falling back to `claude:default` for any
              // unmapped context. The TargetId doubles as the Room
              // key, so multi-tenant A2A traffic lands in the right CC.
              const ctxId = params.message.contextId;
              const targetStr =
                (ctxId !== undefined && contextRoutes[ctxId]) || A2A_FALLBACK_TARGET;
              const target = targetStr as unknown as TargetId;
              const room = await roomRouter.getOrCreateByTarget(target);
              resolvedRoomId = targetStr as unknown as RoomId;
              requestExecutor = executorFactory(room.gateway);
            } else {
              resolvedRoomId = deriveRoomId({
                contextId: params.message.contextId,
              });
              const room = await roomRouter.getOrCreate(resolvedRoomId);
              requestExecutor = executorFactory(room.gateway);
            }
          }
          return handleMessageStream({
            rpcId: normalizeId(rpcId),
            params,
            executor: requestExecutor,
            registry,
            roomId: resolvedRoomId,
          });
        }

        const resp = await dispatch(body, handlers);
        if (resp === null) return new Response(null, { status: 204 });
        return jsonRpcResponse(resp);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const boundPort = server.port ?? config.port;
  log(`listening on http://${host}:${boundPort}${rpcPath}`);

  return {
    host,
    port: boundPort,
    rpcPath,
    async shutdown() {
      log("shutting down");
      server.stop(true);
    },
  };
}

/**
 * Parse the `A2A_BRIDGE_CONTEXT_ROUTES` env-var payload (a JSON object
 * literal) into a `{ contextRoutes }` config fragment. Returns `null`
 * when the env var is absent or malformed so the caller can
 * spread-merge the result unconditionally.
 *
 * Validation of TargetId shape happens later in `startA2AServer` —
 * this parser only enforces JSON shape and key/value string types.
 */
export function parseContextRoutes(
  raw: string | undefined,
  log?: (msg: string) => void,
): { contextRoutes: Record<string, string> } | null {
  if (!raw || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log?.(
      `A2A_BRIDGE_CONTEXT_ROUTES ignored — not valid JSON: ${(err as Error).message}`,
    );
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log?.(`A2A_BRIDGE_CONTEXT_ROUTES ignored — expected a JSON object`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      log?.(
        `A2A_BRIDGE_CONTEXT_ROUTES[${JSON.stringify(k)}] ignored — value is not a string`,
      );
      continue;
    }
    out[k] = v;
  }
  if (Object.keys(out).length === 0) return null;
  return { contextRoutes: out };
}

function extractPath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

function normalizeId(value: unknown): string | number | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function extractParams(raw: string): MessageStreamParams {
  try {
    const parsed = JSON.parse(raw) as { params?: MessageStreamParams };
    const p = parsed?.params;
    if (p && typeof p === "object" && "message" in p) {
      return p as MessageStreamParams;
    }
  } catch {
    /* handled below */
  }
  // Fall back to a minimal empty message so the handler can still run
  // its four-event envelope; executor callers already defend against
  // zero-length user text.
  return { message: { parts: [] } };
}

function jsonRpcResponse(resp: JsonRpcResponse): Response {
  const status =
    "error" in resp && resp.error.code === JSON_RPC_ERRORS.PARSE_ERROR ? 400 : 200;
  return new Response(JSON.stringify(resp), {
    status,
    headers: { "content-type": "application/json" },
  });
}
