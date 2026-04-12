import type { EventEmitter } from "node:events";

/**
 * Transport-neutral abstraction for the daemon's inbound listener layer.
 *
 * A `Listener` owns a server endpoint (stdio pair, unix socket, TLS TCP,
 * ...) and emits one `Connection` per accepted client. Callers consume
 * connections uniformly regardless of the underlying transport.
 *
 * Scope: this interface is the plugin<->daemon control plane contract. It
 * does NOT describe A2A inbound HTTP; that lives under
 * `runtime-daemon/inbound/` and uses its own surface.
 */

/** Events emitted by an established `Connection`. */
export interface ConnectionEvents {
  /** A full text frame arrived from the remote side. */
  message: (frame: string) => void;
  /** The connection has been torn down. No further events will fire. */
  close: () => void;
  /** Non-fatal transport error; implementations should still emit `close` if the socket is unusable. */
  error: (err: Error) => void;
}

/**
 * A single bidirectional frame-oriented channel to a remote peer.
 *
 * Frames are UTF-8 text — JSON payloads are serialized by the caller.
 * The wrapper hides transport specifics (WebSocket, unix socket, stdio
 * framing) behind a uniform send/close/on surface.
 */
export interface Connection extends EventEmitter {
  /** True until the transport layer has fully closed the channel. */
  readonly isOpen: boolean;

  /** Queue a text frame for delivery. Throws if the connection is closed. */
  send(frame: string): void;

  /** Initiate a graceful close. Safe to call multiple times. */
  close(): void;

  on<K extends keyof ConnectionEvents>(event: K, listener: ConnectionEvents[K]): this;
  off<K extends keyof ConnectionEvents>(event: K, listener: ConnectionEvents[K]): this;
  once<K extends keyof ConnectionEvents>(event: K, listener: ConnectionEvents[K]): this;
  emit<K extends keyof ConnectionEvents>(event: K, ...args: Parameters<ConnectionEvents[K]>): boolean;
}

/** Events emitted by a `Listener`. */
export interface ListenerEvents {
  /** A new client attached. The handler owns the `Connection` lifecycle. */
  connection: (conn: Connection) => void;
  /** Fatal listener-level error (bind failure, accept loop crash). */
  error: (err: Error) => void;
}

/**
 * Accepts inbound connections on a single transport endpoint. One
 * `Listener` per active transport in the daemon.
 */
export interface Listener extends EventEmitter {
  /**
   * Begin accepting connections. Resolves once the endpoint is live.
   * Rejects if the endpoint cannot be bound.
   */
  listen(): Promise<void>;

  /**
   * Stop accepting new connections and tear down any established ones.
   * Resolves once all resources are released. Safe to call multiple times.
   */
  close(): Promise<void>;

  on<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): this;
  off<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): this;
  once<K extends keyof ListenerEvents>(event: K, listener: ListenerEvents[K]): this;
  emit<K extends keyof ListenerEvents>(event: K, ...args: Parameters<ListenerEvents[K]>): boolean;
}
