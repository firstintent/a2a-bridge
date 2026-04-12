import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import type { Connection, Listener } from "@transport/listener";

/**
 * Unix-socket transport for same-host plugin<->daemon wiring.
 *
 * Accepts multiple concurrent inbound connections on a single socket
 * path. Frames are UTF-8 newline-delimited (NDJSON) — matching
 * `StdioListener` so callers can use the same framer on either
 * transport.
 */

class UnixSocketConnection extends EventEmitter implements Connection {
  private open = true;
  private buffer = "";

  constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", this.handleData);
    socket.on("end", this.handleEnd);
    socket.on("close", this.handleEnd);
    socket.on("error", this.handleError);
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(frame: string): void {
    if (!this.open) {
      throw new Error("UnixSocketConnection: cannot send on a closed connection");
    }
    this.socket.write(frame + "\n");
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.socket.off("data", this.handleData);
    this.socket.off("end", this.handleEnd);
    this.socket.off("close", this.handleEnd);
    this.socket.off("error", this.handleError);
    try {
      this.socket.end();
    } catch {}
    this.emit("close");
  }

  private handleData = (chunk: string | Buffer): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buffer += text;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (frame.length > 0) this.emit("message", frame);
      idx = this.buffer.indexOf("\n");
    }
  };

  private handleEnd = (): void => {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
  };

  private handleError = (err: Error): void => {
    this.emit("error", err);
  };
}

export interface UnixSocketListenerOptions {
  /** Filesystem path for the listening socket. */
  path: string;
  /**
   * If true, attempt to unlink a stale socket file before binding.
   * Defaults to true — the usual daemon-restart case.
   */
  unlinkStale?: boolean;
}

export class UnixSocketListener extends EventEmitter implements Listener {
  private server: Server | null = null;
  private readonly connections = new Set<UnixSocketConnection>();
  private readonly path: string;
  private readonly unlinkStale: boolean;

  constructor(opts: UnixSocketListenerOptions) {
    super();
    this.path = opts.path;
    this.unlinkStale = opts.unlinkStale ?? true;
  }

  async listen(): Promise<void> {
    if (this.server) {
      throw new Error(`UnixSocketListener: already listening at ${this.path}`);
    }

    if (this.unlinkStale) {
      await unlink(this.path).catch(() => {});
    }

    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;

    server.on("error", (err) => this.emit("error", err));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.path);
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    for (const conn of Array.from(this.connections)) {
      conn.close();
    }
    this.connections.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await unlink(this.path).catch(() => {});
  }

  private handleSocket(socket: Socket): void {
    const conn = new UnixSocketConnection(socket);
    this.connections.add(conn);
    conn.on("close", () => this.connections.delete(conn));
    this.emit("connection", conn);
  }
}
