import type { BridgeMessage } from "@messages/types";

export interface DaemonStatus {
  bridgeReady: boolean;
  tuiConnected: boolean;
  threadId: string | null;
  queuedMessageCount: number;
  proxyUrl: string;
  appServerUrl: string;
  pid: number;
}

// ---------------------------------------------------------------------------
// ACP turn meta
// ---------------------------------------------------------------------------

/**
 * Arbitrary string metadata that travels with an ACP turn start frame and
 * may later be forwarded into `notifications/claude/channel` params.
 *
 * ALL keys MUST match `[a-z0-9_]+`. Claude Code silently drops channel meta
 * keys that contain hyphens, dots, or other non-identifier characters.
 * Use `assertIdentifierSafeKeys` to enforce this at the boundary.
 */
export type AcpTurnMeta = Record<string, string>;

/**
 * Throw an `Error` if any key in `meta` is not identifier-safe
 * (i.e. does not match `^[a-z0-9_]+$`).
 *
 * Call this whenever constructing or deserialising an `acp_turn_start`
 * frame so the constraint is enforced before the meta reaches the plugin.
 */
export function assertIdentifierSafeKeys(meta: AcpTurnMeta): void {
  const BAD = /[^a-z0-9_]/;
  for (const key of Object.keys(meta)) {
    if (key.length === 0 || BAD.test(key)) {
      throw new Error(
        `ACP turn meta key "${key}" is not identifier-safe ([a-z0-9_]+ required)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Control-plane message types
// ---------------------------------------------------------------------------

export type ControlClientMessage =
  | { type: "claude_connect" }
  | { type: "claude_disconnect" }
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage; requireReply?: boolean }
  | { type: "status" }
  // ACP turn relay — sent by the `a2a-bridge acp` subprocess to the daemon.
  | { type: "acp_turn_start"; turnId: string; sessionId: string; userText: string; meta?: AcpTurnMeta }
  | { type: "acp_turn_cancel"; turnId: string };

export type ControlServerMessage =
  | { type: "codex_to_claude"; message: BridgeMessage }
  | { type: "claude_to_codex_result"; requestId: string; success: boolean; error?: string }
  | { type: "status"; status: DaemonStatus }
  // ACP turn relay — sent by the daemon back to the `a2a-bridge acp` subprocess.
  | { type: "acp_turn_chunk"; turnId: string; text: string }
  | { type: "acp_turn_complete"; turnId: string }
  | { type: "acp_turn_error"; turnId: string; message: string };
