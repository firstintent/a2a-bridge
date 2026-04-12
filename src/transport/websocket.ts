import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";
import type { Connection, Listener } from "@transport/listener";

/**
 * WebSocket-over-HTTP listener used by the daemon's control plane.
 *
 * Kept alongside the stdio / unix transports so daemon.ts can depend on
 * `@transport/listener` uniformly. The wire protocol remains JSON frames
 * over WebSocket so DaemonClient stays unchanged.
 *
 * Non-WS HTTP traffic on the same bind (e.g. /healthz, /readyz) is
 * passed through an optional `httpHandler` callback; returning
 * `undefined` lets the listener fall through to its default 404.
 */

interface WSData {
  conn: WebSocketConnection | null;
}

class WebSocketConnection extends EventEmitter implements Connection {
  private open = true;
  private ws: ServerWebSocket<WSData> | null;

  constructor(ws: ServerWebSocket<WSData>) {
    super();
    this.ws = ws;
  }

  get isOpen(): boolean {
    return this.open && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(frame: string): void {
    if (!this.open || !this.ws) {
      throw new Error("WebSocketConnection: cannot send on a closed connection");
    }
    this.ws.send(frame);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    this.emit("close");
  }

  /** Called by the listener when the underlying WS closes on its own. */
  handleUnderlyingClose(): void {
    if (!this.open) return;
    this.open = false;
    this.ws = null;
    this.emit("close");
  }

  /** Called by the listener for each inbound text frame. */
  handleMessage(raw: string | Buffer): void {
    if (!this.open) return;
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    this.emit("message", text);
  }
}

export interface WebSocketListenerOptions {
  /** TCP port to bind. */
  port: number;
  /** Hostname to bind; defaults to 127.0.0.1. */
  hostname?: string;
  /** Path to accept WebSocket upgrades on; defaults to `/ws`. */
  path?: string;
  /** Idle timeout in seconds for the underlying WebSocket. */
  idleTimeoutSec?: number;
  /** Whether Bun sends ping frames to detect half-open sockets. */
  sendPings?: boolean;
  /**
   * Optional handler for non-upgrade HTTP traffic. Return `undefined`
   * to fall through to the listener's default response.
   */
  httpHandler?: (req: Request) => Response | Promise<Response> | undefined;
}

type ServerInstance = ReturnType<typeof Bun.serve<WSData>>;

export class WebSocketListener extends EventEmitter implements Listener {
  private server: ServerInstance | null = null;
  private readonly path: string;

  constructor(private readonly opts: WebSocketListenerOptions) {
    super();
    this.path = opts.path ?? "/ws";
  }

  async listen(): Promise<void> {
    if (this.server) {
      throw new Error(`WebSocketListener: already listening on ${this.opts.hostname ?? "127.0.0.1"}:${this.opts.port}`);
    }

    const self = this;
    this.server = Bun.serve<WSData>({
      port: this.opts.port,
      hostname: this.opts.hostname ?? "127.0.0.1",
      async fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === self.path) {
          if (server.upgrade(req, { data: { conn: null } satisfies WSData })) {
            return undefined;
          }
          return new Response("Upgrade failed", { status: 400 });
        }

        if (self.opts.httpHandler) {
          const custom = await self.opts.httpHandler(req);
          if (custom !== undefined) return custom;
        }

        return new Response("a2a-bridge daemon", { status: 404 });
      },
      websocket: {
        idleTimeout: self.opts.idleTimeoutSec,
        sendPings: self.opts.sendPings,
        open(ws) {
          const conn = new WebSocketConnection(ws);
          ws.data.conn = conn;
          self.emit("connection", conn);
        },
        message(ws, raw) {
          ws.data.conn?.handleMessage(raw as string | Buffer);
        },
        close(ws) {
          ws.data.conn?.handleUnderlyingClose();
        },
      },
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.stop(true);
  }
}
