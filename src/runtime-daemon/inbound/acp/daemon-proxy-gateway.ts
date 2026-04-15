/**
 * DaemonProxyGateway (P8.3).
 *
 * `ClaudeCodeGateway` implementation used inside the `a2a-bridge acp`
 * subprocess.  Opens a WebSocket to the daemon's control plane and
 * relays each ACP turn through the Phase-8.1 wire format
 * (`acp_turn_start` → `acp_turn_chunk*` → `acp_turn_complete`).
 *
 * Design mirrors the plugin-side `DaemonClient`:
 *   - `connect()` is a one-shot that resolves when the socket opens.
 *   - On unexpected close the gateway emits `disconnect` and surfaces
 *     an `error` event on every in-flight turn.  The caller decides
 *     whether to call `connect()` again.
 *
 * Meta forwarding: `startTurn` accepts a `meta` map forwarded verbatim
 * on the `acp_turn_start` frame.  Keys are validated via
 * `assertIdentifierSafeKeys` so any hyphenated / non-identifier key
 * trips the assertion at the boundary rather than being silently
 * dropped when it eventually reaches `notifications/claude/channel`.
 */

import { EventEmitter } from "node:events";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";
import {
  assertIdentifierSafeKeys,
  type AcpTurnMeta,
  type ControlClientMessage,
  type ControlServerMessage,
} from "@transport/control-protocol";

interface DaemonProxyGatewayEvents {
  disconnect: [];
}

export interface DaemonProxyGatewayOptions {
  /** `ws://host:port/path` of the daemon control plane. */
  url: string;
  /**
   * Logical session id stamped onto every `acp_turn_start` frame.  The
   * daemon does not use this field for routing (that is keyed by the
   * control-plane connection identity), but it is carried through for
   * traceability and future multi-session support.
   */
  sessionId?: string;
  /**
   * Default `meta` map stamped onto every `acp_turn_start` frame.  Keys
   * must match `[a-z0-9_]+` (validated at construction time) because
   * they eventually propagate to `notifications/claude/channel` params
   * and CC silently drops non-identifier keys.
   */
  meta?: AcpTurnMeta;
  /**
   * TargetId (P10.4) — `kind:id` form selecting which daemon Room
   * handles every turn from this subprocess. When omitted, frames
   * are sent without a target and the daemon defaults to
   * `claude:default` (v0.1 backward compat).
   */
  target?: string;
  /** How long to wait for the daemon WS to open before failing. */
  connectTimeoutMs?: number;
  /** Optional logger; defaults to no-op. */
  log?: (msg: string) => void;
}

/** Handle tracked per-turn so inbound frames can find the right emitter. */
interface ActiveTurn {
  emitter: ClaudeCodeTurn;
  /** Flipping to true silences all pending listener invocations. */
  settled: { value: boolean };
}

export class DaemonProxyGateway
  extends EventEmitter<DaemonProxyGatewayEvents>
  implements ClaudeCodeGateway
{
  private ws: WebSocket | null = null;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly log: (msg: string) => void;
  private readonly sessionId: string;
  private readonly meta: AcpTurnMeta | undefined;
  private readonly target: string | undefined;
  private readonly connectTimeoutMs: number;

  constructor(private readonly opts: DaemonProxyGatewayOptions) {
    super();
    this.log = opts.log ?? (() => {});
    this.sessionId = opts.sessionId ?? "acp-default";
    this.meta = opts.meta;
    if (this.meta) assertIdentifierSafeKeys(this.meta);
    this.target = opts.target;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open the WebSocket to the daemon.  Resolves once OPEN, rejects on
   * error or timeout.  Safe to call multiple times — a second call with
   * the socket already open is a no-op.
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws) {
      // A non-OPEN lingering socket should be dropped before we replace it.
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {}
        reject(
          new Error(
            `DaemonProxyGateway: connection to ${this.opts.url} timed out after ${this.connectTimeoutMs}ms`,
          ),
        );
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        this.attachHandlers(ws);
        this.log(`DaemonProxyGateway connected to ${this.opts.url}`);
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`DaemonProxyGateway: failed to connect to ${this.opts.url}`));
      };

      ws.onclose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `DaemonProxyGateway: daemon closed the connection during startup (${this.opts.url})`,
          ),
        );
      };
    });
  }

  /** Close the WebSocket and abort every in-flight turn. */
  async disconnect(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    this.failAllTurns(new Error("DaemonProxyGateway disconnected"));
  }

  /** True iff the WS is currently open. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // ClaudeCodeGateway surface
  // ---------------------------------------------------------------------------

  /**
   * Relay `userText` through the daemon as an `acp_turn_start` frame.
   * Chunks stream back as `chunk` events on the returned emitter; the
   * turn ends with exactly one `complete` or `error`.
   */
  startTurn(userText: string): ClaudeCodeTurn {
    const turnId = crypto.randomUUID();
    const emitter = new EventEmitter() as ClaudeCodeTurn;
    const settled = { value: false };

    emitter.cancel = () => {
      const active = this.activeTurns.get(turnId);
      if (!active || active.settled.value) return;
      active.settled.value = true;
      this.activeTurns.delete(turnId);
      this.trySend({ type: "acp_turn_cancel", turnId });
    };

    this.activeTurns.set(turnId, { emitter, settled });

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Surface the failure asynchronously so callers can wire listeners
      // before the error fires.
      queueMicrotask(() => {
        if (settled.value) return;
        settled.value = true;
        this.activeTurns.delete(turnId);
        emitter.emit(
          "error",
          new Error("DaemonProxyGateway: daemon WebSocket is not connected"),
        );
      });
      return emitter;
    }

    const frame: ControlClientMessage = {
      type: "acp_turn_start",
      turnId,
      sessionId: this.sessionId,
      userText,
      ...(this.meta ? { meta: this.meta } : {}),
      ...(this.target ? { target: this.target } : {}),
    };
    this.log(`startTurn ${turnId} (${userText.length} chars)`);
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err: any) {
      queueMicrotask(() => {
        if (settled.value) return;
        settled.value = true;
        this.activeTurns.delete(turnId);
        emitter.emit(
          "error",
          new Error(`DaemonProxyGateway: failed to send acp_turn_start: ${err?.message ?? err}`),
        );
      });
    }
    return emitter;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private attachHandlers(ws: WebSocket): void {
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      let msg: ControlServerMessage;
      try {
        msg = JSON.parse(raw) as ControlServerMessage;
      } catch {
        this.log(`Dropping malformed frame (${raw.length} chars)`);
        return;
      }
      this.handleFrame(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this.ws = null;
      this.log("DaemonProxyGateway socket closed");
      this.failAllTurns(new Error("Daemon WebSocket closed"));
      this.emit("disconnect");
    };

    ws.onerror = () => {
      // The close handler is the single place that tears down pending state.
    };
  }

  private handleFrame(msg: ControlServerMessage): void {
    switch (msg.type) {
      case "acp_turn_chunk": {
        const active = this.activeTurns.get(msg.turnId);
        if (!active || active.settled.value) return;
        active.emitter.emit("chunk", msg.text);
        return;
      }
      case "acp_turn_complete": {
        const active = this.activeTurns.get(msg.turnId);
        if (!active || active.settled.value) return;
        active.settled.value = true;
        this.activeTurns.delete(msg.turnId);
        active.emitter.emit("complete");
        return;
      }
      case "acp_turn_error": {
        const active = this.activeTurns.get(msg.turnId);
        if (!active || active.settled.value) return;
        active.settled.value = true;
        this.activeTurns.delete(msg.turnId);
        active.emitter.emit("error", new Error(msg.message));
        return;
      }
      default:
        // Other server message types (status, codex_to_claude, ...) are
        // addressed to non-gateway clients and silently ignored here.
        return;
    }
  }

  private trySend(frame: ControlClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err: any) {
      this.log(`send failed: ${err?.message ?? err}`);
    }
  }

  private failAllTurns(err: Error): void {
    const entries = Array.from(this.activeTurns.entries());
    this.activeTurns.clear();
    for (const [, active] of entries) {
      if (active.settled.value) continue;
      active.settled.value = true;
      try {
        active.emitter.emit("error", err);
      } catch {}
    }
  }
}
