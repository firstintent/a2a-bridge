import { EventEmitter } from "node:events";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";

/**
 * Daemon-side `ClaudeCodeGateway` implementation.
 *
 * Wires the inbound A2A executor into the same plugin <-> Claude Code
 * pipeline that Codex turns already use:
 *
 *   1. `startTurn(userText)` calls `sendToClaude`, which the daemon
 *      implements as `emitToClaude(systemMessage(...))` — Claude sees a
 *      synthetic "agent message" carrying the A2A user text.
 *   2. Claude responds via the plugin's `reply` tool. The daemon hooks
 *      its existing `claude_to_codex` handler to call
 *      `interceptReply(text)` first; when an inbound turn is active,
 *      the reply text becomes a `chunk` event on the active turn and
 *      the turn `complete`s. Codex injection is skipped.
 *
 * Phase 4 / RoomRouter will replace this single-active-turn shape with
 * a `Map<RoomId, ...>`. For now there is exactly one room per daemon,
 * so a single in-flight turn is sufficient.
 */

interface ActiveTurn {
  id: string;
  emitter: ClaudeCodeTurn;
}

export interface DaemonClaudeCodeGatewayOptions {
  /** Forward user text into the attached Claude Code session. */
  sendToClaude(text: string): void;
  /** Optional logger; defaults to a no-op. */
  log?: (msg: string) => void;
}

export class DaemonClaudeCodeGateway implements ClaudeCodeGateway {
  private active: ActiveTurn | null = null;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: DaemonClaudeCodeGatewayOptions) {
    this.log = opts.log ?? (() => {});
  }

  startTurn(userText: string): ClaudeCodeTurn {
    if (this.active) {
      const prev = this.active.emitter;
      this.active = null;
      prev.emit(
        "error",
        new Error("Inbound turn replaced by a newer one before completion"),
      );
    }

    const id = crypto.randomUUID();
    const emitter = new EventEmitter() as ClaudeCodeTurn;
    emitter.cancel = () => {
      if (this.active?.id !== id) return;
      this.active = null;
      emitter.emit("error", new Error("Inbound turn canceled"));
    };

    this.active = { id, emitter };
    this.log(`startTurn(${id}) — forwarding ${userText.length} chars to Claude`);
    try {
      this.opts.sendToClaude(userText);
    } catch (err) {
      this.active = null;
      const reason = err instanceof Error ? err.message : String(err);
      queueMicrotask(() =>
        emitter.emit("error", new Error(`Failed to forward to Claude: ${reason}`)),
      );
    }
    return emitter;
  }

  /**
   * Called by the daemon's `claude_to_codex` handler. Returns true if
   * an active inbound turn consumed the reply (in which case the daemon
   * should NOT also inject the text into Codex).
   *
   * Reply semantics: each reply text is treated as the full CC turn —
   * it becomes one `chunk` and the turn `complete`s. The daemon already
   * gates on `tuiConnectionState.canReply()` before calling this, so
   * there is no expectation of multiple replies per A2A turn today.
   */
  interceptReply(text: string): boolean {
    const turn = this.active;
    if (!turn) return false;
    this.active = null;
    this.log(`interceptReply — delivering ${text.length} chars to turn ${turn.id}`);
    turn.emitter.emit("chunk", text);
    turn.emitter.emit("complete");
    return true;
  }

  /** True iff an A2A turn is waiting for Claude Code to reply. */
  hasActiveTurn(): boolean {
    return this.active !== null;
  }
}
