import { EventEmitter } from "node:events";
import type { BridgeMessage } from "@messages/types";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "@transport/control-protocol";

interface DaemonClientEvents {
  codexMessage: [BridgeMessage];
  disconnect: [];
  status: [DaemonStatus];
  // P10.6 — conflict outcomes on `claude_connect`.
  // `connectRejected` fires when another CC already owns the target
  // and the plugin didn't pass `force=true`. `connectReplaced` fires
  // on the old attach when someone else took over with `force=true`.
  connectRejected: [{ target: string; reason: string }];
  connectReplaced: [{ target: string }];
}

let nextSocketId = 0;

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private ws: WebSocket | null = null;
  private wsId: number = 0; // Track socket identity for debugging
  private nextRequestId = 1;
  private pendingReplies = new Map<
    string,
    {
      resolve: (value: { success: boolean; error?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly url: string) {
    super();
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.log(`connect() skipped — ws#${this.wsId} already OPEN`);
      return;
    }

    // Close any lingering socket in non-OPEN state to avoid orphans
    if (this.ws) {
      const state = this.ws.readyState;
      this.log(`connect() closing lingering ws#${this.wsId} (readyState=${state})`);
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const socketId = ++nextSocketId;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error(`Connection to A2aBridge daemon at ${this.url} timed out`));
      }, 10_000);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        this.wsId = socketId;
        this.attachSocketHandlers(ws, socketId);
        this.log(`ws#${socketId} opened and attached`);
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to connect to A2aBridge daemon at ${this.url}`));
      };

      ws.onclose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`A2aBridge daemon closed the connection during startup (${this.url})`));
      };
    });
  }

  /**
   * Attach this client as Claude Code on the daemon control plane.
   * Pass `target` ("kind:id" form) to claim a specific Room when
   * the daemon supports multi-target routing (P10.x / v0.2). When
   * omitted, the daemon assigns `claude:default` (v0.1 behaviour).
   *
   * P10.6: `force=true` kicks an attached CC that already owns the
   * target. Default (`force=false`) makes the daemon reject the
   * attach and emit a `connectRejected` event on this client.
   */
  attachClaude(target?: string, force: boolean = false) {
    this.send({
      type: "claude_connect",
      ...(target ? { target } : {}),
      ...(force ? { force: true } : {}),
    });
  }

  async disconnect() {
    if (!this.ws) return;

    try {
      this.send({ type: "claude_disconnect" });
    } catch {}

    try {
      this.ws.close();
    } catch {}

    this.ws = null;
    this.rejectPendingReplies("Daemon connection closed");
  }

  /**
   * Ship a `BridgeMessage` back over the control plane as a
   * `claude_to_codex` frame. P10.8 adds optional `target`: when set,
   * the daemon forwards the reply to that TargetId's Room instead of
   * the inbound turn's originator. Omitted = today's behaviour.
   */
  async sendReply(
    message: BridgeMessage,
    requireReply?: boolean,
    target?: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: "A2aBridge daemon is not connected." };
    }

    const requestId = `reply_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        resolve({ success: false, error: "Timed out waiting for A2aBridge daemon reply." });
      }, 15000);

      this.pendingReplies.set(requestId, { resolve, timer });
      this.send({
        type: "claude_to_codex",
        requestId,
        message,
        ...(requireReply ? { requireReply: true } : {}),
        ...(target ? { target } : {}),
      });
    });
  }

  private attachSocketHandlers(ws: WebSocket, socketId: number) {
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();

      let message: ControlServerMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      switch (message.type) {
        case "codex_to_claude":
          this.emit("codexMessage", message.message);
          return;
        case "claude_to_codex_result": {
          const pending = this.pendingReplies.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingReplies.delete(message.requestId);
          pending.resolve({ success: message.success, error: message.error });
          return;
        }
        case "status":
          this.emit("status", message.status);
          return;
        case "claude_connect_rejected":
          this.emit("connectRejected", {
            target: message.target,
            reason: message.reason,
          });
          return;
        case "claude_connect_replaced":
          this.emit("connectReplaced", { target: message.target });
          return;
      }
    };

    ws.onclose = (event) => {
      const isCurrent = this.ws === ws;
      this.log(`ws#${socketId} onclose (code=${event.code}, reason=${event.reason || "none"}, isCurrent=${isCurrent}, currentWsId=${this.wsId})`);
      if (isCurrent) {
        this.ws = null;
        this.rejectPendingReplies("A2aBridge daemon disconnected.");
        this.emit("disconnect");
      }
      // If this.ws !== ws, this socket was replaced by a newer connection —
      // don't emit "disconnect" or it will trigger a reconnect loop.
    };

    ws.onerror = () => {
      // The close handler is the single place that tears down pending state.
    };
  }

  private rejectPendingReplies(error: string) {
    for (const [requestId, pending] of this.pendingReplies.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, error });
      this.pendingReplies.delete(requestId);
    }
  }

  private send(message: ControlClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("A2aBridge daemon socket is not open.");
    }

    this.ws.send(JSON.stringify(message));
  }

  private log(msg: string) {
    process.stderr.write(`[${new Date().toISOString()}] [DaemonClient] ${msg}\n`);
  }
}
