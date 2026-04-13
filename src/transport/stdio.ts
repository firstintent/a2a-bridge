import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { Connection, Listener } from "@transport/listener";

/**
 * Stdio transport for the plugin<->daemon control plane.
 *
 * A stdio process has exactly one peer (its launcher), so this listener
 * emits a single `connection` event once `listen()` is called. Frames
 * are UTF-8 text, newline-delimited (NDJSON-style) — the same framing
 * used by JSON-RPC-over-stdio peers.
 */

class StdioConnection extends EventEmitter implements Connection {
  private open = true;
  private buffer = "";

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    super();
    if (typeof (input as { setEncoding?: (e: string) => void }).setEncoding === "function") {
      (input as { setEncoding: (e: string) => void }).setEncoding("utf8");
    }
    input.on("data", this.handleData);
    input.on("end", this.handleEnd);
    input.on("error", this.handleError);
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(frame: string): void {
    if (!this.open) {
      throw new Error("StdioConnection: cannot send on a closed connection");
    }
    this.output.write(frame + "\n");
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.input.off("data", this.handleData);
    this.input.off("end", this.handleEnd);
    this.input.off("error", this.handleError);
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

export interface StdioListenerOptions {
  /** Input stream; defaults to `process.stdin`. */
  input?: Readable;
  /** Output stream; defaults to `process.stdout`. */
  output?: Writable;
}

export class StdioListener extends EventEmitter implements Listener {
  private connection: StdioConnection | null = null;
  private started = false;
  private readonly input: Readable;
  private readonly output: Writable;

  constructor(opts: StdioListenerOptions = {}) {
    super();
    this.input = opts.input ?? (process.stdin as unknown as Readable);
    this.output = opts.output ?? (process.stdout as unknown as Writable);
  }

  async listen(): Promise<void> {
    if (this.started) {
      throw new Error("StdioListener: already listening");
    }
    this.started = true;
    const connection = new StdioConnection(this.input, this.output);
    this.connection = connection;
    queueMicrotask(() => {
      if (this.connection === connection) {
        this.emit("connection", connection);
      }
    });
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.connection) {
      const conn = this.connection;
      this.connection = null;
      conn.close();
    }
  }
}
