import type { EventEmitter } from "node:events";

/**
 * Abstraction over "the daemon's single active Claude Code room".
 *
 * The A2A inbound service does not reach into peer adapters directly
 * (dep-cruiser rule `inbound-does-not-reach-into-peers`). Instead it
 * goes through a gateway whose concrete implementation lives in
 * daemon.ts and wraps the same `reply` / `attachedClaude` pipeline the
 * plugin already drives.
 *
 * For Phase 2 there is exactly one room per daemon (RoomRouter lands
 * in Phase 4). `startTurn` is therefore a bare top-level call — no
 * roomId, no contextId threading yet.
 */
export interface ClaudeCodeGateway {
  /**
   * Forward a user message into Claude Code. Returns a handle whose
   * event stream is the turn's reply: zero or more `chunk` events
   * followed by exactly one terminal `complete` or `error`.
   */
  startTurn(userText: string): ClaudeCodeTurn;
}

export interface ClaudeCodeTurnEvents {
  /** Incremental text chunk from Claude Code's reply. */
  chunk: (text: string) => void;
  /** Turn ended normally. No further events will fire. */
  complete: () => void;
  /** Turn ended abnormally. No further events will fire. */
  error: (err: Error) => void;
}

export interface ClaudeCodeTurn extends EventEmitter {
  /** Abort a turn in flight. Implementations may treat this as best-effort. */
  cancel(): void;

  on<K extends keyof ClaudeCodeTurnEvents>(
    event: K,
    listener: ClaudeCodeTurnEvents[K],
  ): this;
  off<K extends keyof ClaudeCodeTurnEvents>(
    event: K,
    listener: ClaudeCodeTurnEvents[K],
  ): this;
  once<K extends keyof ClaudeCodeTurnEvents>(
    event: K,
    listener: ClaudeCodeTurnEvents[K],
  ): this;
  emit<K extends keyof ClaudeCodeTurnEvents>(
    event: K,
    ...args: Parameters<ClaudeCodeTurnEvents[K]>
  ): boolean;
}
