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

export interface AcpTurnHandlerOpts {
  permissionTimeoutMs?: number;
  /**
   * Optional predicate (P10.4): given a TargetId from acp_turn_start,
   * return true iff a Claude Code instance is currently attached for
   * that target. Returning false short-circuits the turn with an
   * `acp_turn_error` instead of forwarding to the singleton gateway.
   * When omitted, every target is considered attached (v0.1 behaviour).
   */
  isTargetAttached?: (target: string) => boolean;
}

/**
 * Resolve the `ClaudeCodeGateway` for a given TargetId. The daemon
 * wires this through `inboundRoomRouter.getOrCreateByTarget` so each
 * TargetId gets its own per-Room gateway (P10.10). Returning `null`
 * treats the target as unresolvable and surfaces an `acp_turn_error`
 * to the caller — same shape as the `isTargetAttached` rejection
 * path. Async because creating a Room may spin up per-Room state.
 */
export type GatewayForTarget = (
  target: string,
) => ClaudeCodeGateway | null | Promise<ClaudeCodeGateway | null>;

export class AcpTurnHandler {
  private readonly activeTurns = new Map<Connection, ActiveTurn>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly log: (msg: string) => void;
  private readonly permissionTimeoutMs: number;
  private readonly isTargetAttached?: (target: string) => boolean;

  constructor(
    private readonly gatewayForTarget: GatewayForTarget,
    log?: (msg: string) => void,
    opts?: AcpTurnHandlerOpts,
  ) {
    this.log = log ?? (() => {});
    this.permissionTimeoutMs = opts?.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.isTargetAttached = opts?.isTargetAttached;
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

  async handleTurnStart(
    conn: Connection,
    msg: Extract<ControlClientMessage, { type: "acp_turn_start" }>,
  ): Promise<void> {
    // P10.4 — verify the requested TargetId has an attached CC before
    // we reach into the gateway. Falls back to claude:default when the
    // subprocess didn't send a target (v0.1 wire compatibility).
    const target = msg.target ?? "claude:default";
    if (this.isTargetAttached && !this.isTargetAttached(target)) {
      this.log(`Rejecting acp_turn_start ${msg.turnId} — target ${target} not attached`);
      this.send(conn, {
        type: "acp_turn_error",
        turnId: msg.turnId,
        message: `target ${target} not attached`,
      });
      return;
    }

    // P10.10 — resolve the Room's gateway for this target. Rejection
    // path: if the gateway can't be found/created, surface a matching
    // error frame instead of forwarding into a shared singleton.
    const gateway = await this.gatewayForTarget(target);
    if (!gateway) {
      this.log(`Rejecting acp_turn_start ${msg.turnId} — no gateway for ${target}`);
      this.send(conn, {
        type: "acp_turn_error",
        turnId: msg.turnId,
        message: `no gateway for target ${target}`,
      });
      return;
    }

    // Settle + cancel any existing turn for this connection before starting a new one.
    this.settleTurn(conn, `superseded by ${msg.turnId}`);

    const turn = gateway.startTurn(msg.userText);
    const settled = { value: false };
    this.activeTurns.set(conn, { turnId: msg.turnId, turn, settled });
    this.log(`ACP turn started (turnId=${msg.turnId}, ${msg.userText.length} chars, target=${target})`);

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
