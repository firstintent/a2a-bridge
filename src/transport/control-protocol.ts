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

/**
 * Permission verdict bridged between CC (`notifications/claude/channel/permission_request`)
 * and the ACP client's `session/request_permission` reply.
 */
export type PermissionOutcome = "allow" | "deny";

export type ControlClientMessage =
  // `target` is the `kind:id` TargetId (see shared/target-id.ts).
  // Optional for v0.1 backward compat; when omitted the daemon
  // assigns `claude:default`.
  // `force` (P10.6): when true and the target already has an attached
  // CC, kick the old attach; without `force` the daemon rejects the
  // new attach instead.
  | { type: "claude_connect"; target?: string; force?: boolean }
  | { type: "claude_disconnect" }
  | { type: "claude_to_codex"; requestId: string; message: BridgeMessage; requireReply?: boolean }
  | { type: "status" }
  // ACP turn relay — sent by the `a2a-bridge acp` subprocess to the daemon.
  // `target` (P10.4) selects which TargetId Room handles the turn.
  // Optional for v0.1 backward compat; daemon defaults to `claude:default`.
  | { type: "acp_turn_start"; turnId: string; sessionId: string; userText: string; meta?: AcpTurnMeta; target?: string }
  | { type: "acp_turn_cancel"; turnId: string }
  // Plugin → daemon: CC asked for a permission verdict; daemon decides where
  // to forward it based on the currently-active inbound turn.
  | { type: "plugin_permission_request"; requestId: string; toolName: string; description: string; inputPreview: string }
  // ACP subprocess → daemon: the ACP client answered a previously-forwarded
  // permission request (see `acp_permission_request` below).
  | { type: "acp_permission_response"; requestId: string; outcome: PermissionOutcome }
  // Inspection RPC (P10.5): list every target the daemon currently
  // tracks, used by `a2a-bridge daemon targets`.
  | { type: "list_targets"; requestId: string };

export type ControlServerMessage =
  | { type: "codex_to_claude"; message: BridgeMessage }
  | { type: "claude_to_codex_result"; requestId: string; success: boolean; error?: string }
  | { type: "status"; status: DaemonStatus }
  // ACP turn relay — sent by the daemon back to the `a2a-bridge acp` subprocess.
  | { type: "acp_turn_chunk"; turnId: string; text: string }
  | { type: "acp_turn_complete"; turnId: string }
  | { type: "acp_turn_error"; turnId: string; message: string }
  // Daemon → plugin: final verdict the plugin should forward back to CC as a
  // `notifications/claude/channel/permission` notification.
  | { type: "plugin_permission_response"; requestId: string; outcome: PermissionOutcome }
  // Daemon → ACP subprocess: route a CC-originated permission request to the
  // ACP client via `AgentSideConnection.requestPermission`.
  | { type: "acp_permission_request"; requestId: string; turnId: string; toolName: string; description: string; inputPreview: string }
  // Inspection RPC response (P10.5): one entry per registered target.
  | { type: "targets_response"; requestId: string; targets: TargetEntry[] }
  // Daemon → plugin (P10.6): the plugin's `claude_connect` lost a
  // conflict — another CC is already attached to the same TargetId.
  // The plugin should surface `reason` to CC and stop reconnecting.
  | { type: "claude_connect_rejected"; target: string; reason: string }
  // Daemon → plugin (P10.6): another `claude_connect` arrived with
  // `force: true` and took over this TargetId. The old attach
  // receives this frame just before the daemon closes the socket.
  | { type: "claude_connect_replaced"; target: string };

/** Snapshot of one TargetId Room's attach state for `daemon targets`. */
export interface TargetEntry {
  /** `kind:id` form. */
  target: string;
  /** True iff a CC / peer is currently attached for this target. */
  attached: boolean;
  /** Numeric attach connection id (for diagnostics); undefined when detached. */
  clientId?: number;
  /** ms since epoch when the current attach landed; undefined when detached. */
  attachedAt?: number;
}
