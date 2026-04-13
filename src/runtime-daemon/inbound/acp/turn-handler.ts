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

export class AcpTurnHandler {
  private readonly activeTurns = new Map<Connection, ActiveTurn>();
  private readonly log: (msg: string) => void;

  constructor(
    private readonly gateway: ClaudeCodeGateway,
    log?: (msg: string) => void,
  ) {
    this.log = log ?? (() => {});
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
   */
  onConnectionClose(conn: Connection): void {
    this.settleTurn(conn, "connection closed");
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
