import type { EventEmitter } from "node:events";
import type { BridgeMessage } from "./types.ts";

/**
 * Contract every peer-side adapter must implement. One adapter per target
 * agent: CodexAdapter, OpenClawAdapter, HermesAdapter, ...
 *
 * The daemon owns exactly one IPeerAdapter instance per room and drives it
 * through this interface. Events are emitted through Node's EventEmitter.
 *
 * Event map:
 *   ready            — peer is connected and ready to accept turns
 *   agentMessage     — assistant produced a message (final or chunk)
 *   agentThought     — assistant's intermediate reasoning (optional;
 *                      only peers that expose it, e.g. Hermes ACP)
 *   turnStarted      — a turn has begun (may be synthesized)
 *   turnCompleted    — a turn finished; payload includes stop reason
 *   toolEvent        — peer reported a tool-call lifecycle event
 *   permissionRequest — peer is asking the bridge to approve something
 *   error            — non-fatal error; caller may log and continue
 *   exit             — peer connection closed; adapter is no longer usable
 */
export interface PeerAdapterEvents {
  ready: (info: { peerName: string; sessionId?: string }) => void;
  agentMessage: (msg: BridgeMessage & { final?: boolean }) => void;
  agentThought: (msg: { text: string; timestamp: number }) => void;
  turnStarted: () => void;
  turnCompleted: (info: {
    stopReason?: "end_turn" | "cancelled" | "refusal" | "error" | string;
    usage?: Record<string, unknown>;
  }) => void;
  toolEvent: (evt: {
    id: string;
    phase: "start" | "update" | "complete";
    title?: string;
    status?: string;
    payload?: unknown;
  }) => void;
  permissionRequest: (req: {
    id: string;
    tool: string;
    description?: string;
    input?: unknown;
  }) => void;
  error: (err: Error) => void;
  exit: (info: { code?: number; reason?: string }) => void;
}

export interface PeerAdapterStartOptions {
  /** Filesystem context for peers that need a working directory (e.g. Hermes). */
  cwd?: string;
  /** Opaque per-adapter configuration, validated by the adapter itself. */
  config?: Record<string, unknown>;
}

export interface IPeerAdapter extends EventEmitter {
  /** Stable identifier for logging/routing (e.g. "codex", "openclaw", "hermes"). */
  readonly peerName: string;

  /** True while a turn is in flight. Adapters must guard injectMessage on this. */
  readonly turnInProgress: boolean;

  /** Open the peer connection. Resolves once the adapter is ready to accept turns. */
  start(opts: PeerAdapterStartOptions): Promise<void>;

  /**
   * Submit a user turn to the peer.
   * Returns false if a turn is already in progress; true if accepted.
   * Adapters that want to support interleaved messages can override this
   * contract, but the default daemon routing assumes strict one-turn-at-a-time.
   */
  injectMessage(text: string, opts?: { images?: string[] }): Promise<boolean> | boolean;

  /** Request the peer to abort the current turn, if any. */
  cancel(): Promise<void>;

  /** Close the peer connection and release resources. */
  close(): Promise<void>;

  // EventEmitter strong typing — adapters should implement these overloads
  // so callers get autocompletion on on/off/emit with PeerAdapterEvents keys.
  on<K extends keyof PeerAdapterEvents>(event: K, listener: PeerAdapterEvents[K]): this;
  off<K extends keyof PeerAdapterEvents>(event: K, listener: PeerAdapterEvents[K]): this;
  emit<K extends keyof PeerAdapterEvents>(event: K, ...args: Parameters<PeerAdapterEvents[K]>): boolean;
}
