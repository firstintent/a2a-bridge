import { createLogger, type Logger } from "@shared/logger";

/**
 * A2A-over-HTTP server skeleton.
 *
 * This is the bind layer only — health endpoint, request logging, and a
 * graceful shutdown handle. Agent-card, auth, JSON-RPC dispatch, and the
 * `message/stream` SSE handler land in subsequent P2.8–P2.14 tasks.
 */

export interface A2aServerConfig {
  /** Hostname or IP to bind; defaults to 127.0.0.1. */
  host?: string;
  /** TCP port to bind. */
  port: number;
  /** Optional log file path; when set, request log lines are tee'd there. */
  logFilePath?: string;
  /** Override the internal logger; mainly for tests. */
  logger?: Logger;
}

export interface A2aServerHandle {
  /** Host the server is bound to. */
  readonly host: string;
  /** Port the server is listening on. */
  readonly port: number;
  /** Stop accepting new requests and release the bind. */
  shutdown(): Promise<void>;
}

export async function startA2AServer(config: A2aServerConfig): Promise<A2aServerHandle> {
  const host = config.host ?? "127.0.0.1";
  const log =
    config.logger ?? createLogger({ tag: "A2aHttpServer", filePath: config.logFilePath });

  const server = Bun.serve({
    port: config.port,
    hostname: host,
    fetch(req) {
      const url = new URL(req.url);
      log(`${req.method} ${url.pathname}`);

      if (url.pathname === "/healthz") {
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const boundPort = server.port ?? config.port;
  log(`listening on http://${host}:${boundPort}`);

  return {
    host,
    port: boundPort,
    async shutdown() {
      log("shutting down");
      server.stop(true);
    },
  };
}
