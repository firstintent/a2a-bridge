/**
 * Daemon-side ACP turn handler (P8.2).
 *
 * Bridges the WS control-plane `acp_turn_start` / `acp_turn_cancel`
 * frames from an `a2a-bridge acp` subprocess into the shared
 * `ClaudeCodeGateway`, then pipes the resulting turn events back as
 * `acp_turn_chunk` / `acp_turn_complete` / `acp_turn_error` frames.
 *
 * One control-plane `Connection` can own at most one in-flight ACP turn
 * at a time.  A second `acp_turn_start` on the same connection cancels
 * the previous turn before starting the new one.  `onConnectionClose`
 * must be called when the control-plane socket closes so the handler
 * can cancel any lingering turn and release its entry from the map.
 */

import type { Connection } from "@transport/listener";
import type {
  ControlClientMessage,
  ControlServerMessage,
  PermissionOutcome,
} from "@transport/control-protocol";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";

interface ActiveTurn {
  turnId: string;
  turn: ClaudeCodeTurn;
  /** Flipping this to true silences all pending listeners for the turn. */
  settled: { value: boolean };
}

/**
 * Pending permission verdict awaited by the caller of `routePermissionRequest`.
 * Resolved by `handlePermissionResponse` when the ACP subprocess answers.
 */
interface PendingPermission {
  conn: Connection;
  resolve: (outcome: PermissionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Default ceiling for how long a permission round-trip may take before the
 * daemon gives up and auto-denies.  Matches the Channels reference spec:
 * the user gets a few minutes to respond via their ACP client's UI.
 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1_000;

export class AcpTurnHandler {
  private readonly activeTurns = new Map<Connection, ActiveTurn>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly log: (msg: string) => void;
  private readonly permissionTimeoutMs: number;

  constructor(
    private readonly gateway: ClaudeCodeGateway,
    log?: (msg: string) => void,
    opts?: { permissionTimeoutMs?: number },
  ) {
    this.log = log ?? (() => {});
    this.permissionTimeoutMs = opts?.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

  // ---------------------------------------------------------------------------
  // Permission bridging (P8.2a)
  // ---------------------------------------------------------------------------

  /**
   * Forward a CC-originated permission request to whichever ACP subprocess
   * currently owns the active inbound turn, and return a promise that
   * resolves with the ACP client's verdict.
   *
   * Returns `"deny"` immediately when no ACP turn is in flight — permission
   * requests without a human on the other end can't be answered, and
   * defaulting to deny is the safe choice.
   */
  routePermissionRequest(req: {
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }): Promise<PermissionOutcome> {
    // Pick any connection with an active turn.  v0.1 has at most one ACP
    // subprocess attached at a time in practice; if multiple are attached,
    // the one whose turn is in flight is the correct owner.
    const [conn, active] = this.activeTurns.entries().next().value ?? [undefined, undefined];
    if (!conn || !active) {
      this.log(`No active ACP turn — auto-denying permission ${req.requestId}`);
      return Promise.resolve("deny");
    }

    return new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingPermissions.get(req.requestId);
        if (!pending) return;
        this.pendingPermissions.delete(req.requestId);
        this.log(`Permission ${req.requestId} timed out after ${this.permissionTimeoutMs}ms — auto-denying`);
        resolve("deny");
      }, this.permissionTimeoutMs);

      this.pendingPermissions.set(req.requestId, { conn, resolve, timer });
      this.log(
        `Forwarding permission ${req.requestId} (${req.toolName}) to ACP turn ${active.turnId}`,
      );
      this.send(conn, {
        type: "acp_permission_request",
        requestId: req.requestId,
        turnId: active.turnId,
        toolName: req.toolName,
        description: req.description,
        inputPreview: req.inputPreview,
      });
    });
  }

  handlePermissionResponse(
    conn: Connection,
    msg: Extract<ControlClientMessage, { type: "acp_permission_response" }>,
  ): void {
    const pending = this.pendingPermissions.get(msg.requestId);
    if (!pending) {
      this.log(`Dropping unknown acp_permission_response ${msg.requestId}`);
      return;
    }
    if (pending.conn !== conn) {
      this.log(
        `Dropping acp_permission_response ${msg.requestId} from wrong connection`,
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(msg.requestId);
    this.log(`Permission ${msg.requestId} resolved: ${msg.outcome}`);
    pending.resolve(msg.outcome);
  }

  handleTurnStart(
    conn: Connection,
    msg: Extract<ControlClientMessage, { type: "acp_turn_start" }>,
  ): void {
    // Settle + cancel any existing turn for this connection before starting a new one.
    this.settleTurn(conn, `superseded by ${msg.turnId}`);

    const turn = this.gateway.startTurn(msg.userText);
    const settled = { value: false };
    this.activeTurns.set(conn, { turnId: msg.turnId, turn, settled });
    this.log(`ACP turn started (turnId=${msg.turnId}, ${msg.userText.length} chars)`);

    turn.on("chunk", (text) => {
      if (settled.value) return;
      this.send(conn, { type: "acp_turn_chunk", turnId: msg.turnId, text });
    });

    turn.on("complete", () => {
      if (settled.value) return;
      settled.value = true;
      this.activeTurns.delete(conn);
      this.log(`ACP turn complete (turnId=${msg.turnId})`);
      this.send(conn, { type: "acp_turn_complete", turnId: msg.turnId });
    });

    turn.on("error", (err) => {
      if (settled.value) return;
      settled.value = true;
      this.activeTurns.delete(conn);
      this.log(`ACP turn error (turnId=${msg.turnId}): ${err.message}`);
      this.send(conn, {
        type: "acp_turn_error",
        turnId: msg.turnId,
        message: err.message,
      });
    });
  }

  handleTurnCancel(
    conn: Connection,
    msg: Extract<ControlClientMessage, { type: "acp_turn_cancel" }>,
  ): void {
    const active = this.activeTurns.get(conn);
    if (!active || active.turnId !== msg.turnId) {
      this.log(`acp_turn_cancel ignored: no active turn ${msg.turnId} on this connection`);
      return;
    }
    this.log(`Cancelling ACP turn ${msg.turnId}`);
    this.settleTurn(conn, "cancelled by client");
  }

  /**
   * Must be called when the control-plane connection closes so that any
   * in-flight turn is cleaned up and the per-connection entry is removed.
   * Also auto-denies any permission requests still awaiting a verdict
   * from this connection — the ACP client will never answer now.
   */
  onConnectionClose(conn: Connection): void {
    this.settleTurn(conn, "connection closed");
    this.denyPendingPermissionsFor(conn, "connection closed");
  }

  private denyPendingPermissionsFor(conn: Connection, reason: string): void {
    for (const [requestId, pending] of this.pendingPermissions.entries()) {
      if (pending.conn !== conn) continue;
      this.log(`Auto-denying pending permission ${requestId} (${reason})`);
      clearTimeout(pending.timer);
      this.pendingPermissions.delete(requestId);
      pending.resolve("deny");
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private settleTurn(conn: Connection, reason: string): void {
    const active = this.activeTurns.get(conn);
    if (!active) return;
    this.log(`Settling turn ${active.turnId} (${reason})`);
    active.settled.value = true;
    this.activeTurns.delete(conn);
    try {
      active.turn.cancel();
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private send(conn: Connection, msg: ControlServerMessage): void {
    if (!conn.isOpen) return;
    try {
      conn.send(JSON.stringify(msg));
    } catch (err: any) {
      this.log(`Failed to send ACP frame: ${err?.message ?? err}`);
    }
  }
}
