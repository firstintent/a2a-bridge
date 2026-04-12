import { createLogger, type Logger } from "@shared/logger";
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
import { TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";
import {
  createEchoExecutor,
  handleMessageStream,
  type MessageStreamExecutor,
  type MessageStreamParams,
} from "@daemon/inbound/a2a-http/handlers/message-stream";
import { createTasksGetHandler } from "@daemon/inbound/a2a-http/handlers/tasks-get";
import { createTasksCancelHandler } from "@daemon/inbound/a2a-http/handlers/tasks-cancel";

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
   */
  messageStreamExecutor?: MessageStreamExecutor;
  /**
   * Shared task registry. Created internally when omitted; callers that
   * want to inspect task state in tests pass their own.
   */
  registry?: TaskRegistry;
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
  const registry = config.registry ?? new TaskRegistry();
  const executor = config.messageStreamExecutor ?? createEchoExecutor();

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
          return handleMessageStream({
            rpcId: normalizeId(rpcId),
            params: extractParams(body),
            executor,
            registry,
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
