#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { CodexAdapter } from "@daemon/peers/codex/codex-adapter";
import {
  BRIDGE_CONTRACT_REMINDER,
  REPLY_REQUIRED_INSTRUCTION,
  StatusBuffer,
  classifyMessage,
  type FilterMode,
} from "@daemon/message-filter";
import { TuiConnectionState } from "@daemon/peers/codex/tui-connection-state";
import { DaemonLifecycle } from "@shared/daemon-lifecycle";
import { StateDirResolver } from "@shared/state-dir";
import { ConfigService } from "@shared/config-service";
import type { Connection } from "@transport/listener";
import { WebSocketListener } from "@transport/websocket";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "@transport/control-protocol";
import type { BridgeMessage } from "@messages/types";
import { parseTarget, type TargetId } from "@shared/target-id";
import { DaemonClaudeCodeGateway } from "@daemon/inbound/daemon-claude-code-gateway";
import { Room } from "@daemon/rooms/room";
import { RoomRouter } from "@daemon/rooms/room-router";
import { DEFAULT_ROOM_ID } from "@daemon/rooms/room-id";
import { SqliteTaskLog } from "@daemon/tasks/task-log";
import {
  parseContextRoutes,
  startA2AServer,
  type A2aServerHandle,
} from "@daemon/inbound/a2a-http/server";
import {
  createClaudeCodeExecutor,
  createEchoExecutor,
} from "@daemon/inbound/a2a-http/handlers/message-stream";
import { AcpTurnHandler } from "@daemon/inbound/acp/turn-handler";

interface ControlClientMeta {
  clientId: number;
  attached: boolean;
}

const stateDir = new StateDirResolver();
stateDir.ensure();
const configService = new ConfigService();
const config = configService.loadOrDefault();

const CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.daemon.port), 10);
const CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.daemon.proxyPort), 10);
const CONTROL_PORT = parseInt(process.env.A2A_BRIDGE_CONTROL_PORT ?? "4512", 10);
const TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
const CLAUDE_DISCONNECT_GRACE_MS = 5_000;
const MAX_BUFFERED_MESSAGES = parseInt(process.env.A2A_BRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
const FILTER_MODE: FilterMode =
  (process.env.A2A_BRIDGE_FILTER_MODE as FilterMode) === "full" ? "full" : "filtered";
const IDLE_SHUTDOWN_MS = parseInt(process.env.A2A_BRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000), 10);
const ATTENTION_WINDOW_MS = parseInt(process.env.A2A_BRIDGE_ATTENTION_WINDOW_MS ?? String(config.turnCoordination.attentionWindowSeconds * 1000), 10);

const A2A_INBOUND_PORT = parseInt(process.env.A2A_BRIDGE_A2A_PORT ?? "4520", 10);
const A2A_INBOUND_HOST = process.env.A2A_BRIDGE_A2A_HOST ?? "127.0.0.1";
const A2A_INBOUND_TOKEN = process.env.A2A_BRIDGE_BEARER_TOKEN ?? "";
const A2A_INBOUND_PUBLIC_CARD = process.env.A2A_BRIDGE_PUBLIC_AGENT_CARD !== "false";

const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

let controlListener: WebSocketListener | null = null;
let a2aInboundServer: A2aServerHandle | null = null;
// P10.3 — Map<TargetId, Connection> of currently attached Claude Code
// instances. v0.1 single-CC behaviour is the special case where the
// only key is "claude:default". `attachedClaude` (singular) is kept
// as a back-compat pointer to "the most-recently attached CC" so the
// existing emitToClaude / broadcast paths keep working unchanged
// until P10.4 / P10.7 wire per-target routing through the gateway.
const attachedClaudeByTarget = new Map<string, Connection>();
const attachedAtByTarget = new Map<string, number>();
let attachedClaude: Connection | null = null;
const controlClientMeta = new WeakMap<Connection, ControlClientMeta>();
const claudeConnTarget = new WeakMap<Connection, string>();
let nextControlClientId = 0;

// v0.1 default gateway — used by `defaultRoom` (room id `"default"`)
// for backward-compat A2A HTTP turns (no contextRoutes, no explicit
// target). Delivers via `emitToClaude` which hits the singleton
// `attachedClaude`. Per-target rooms get their own gateway below
// via the RoomRouter factory, so each target routes to its own
// attached CC instead of the singleton (P10.10).
const inboundGateway = new DaemonClaudeCodeGateway({
  sendToClaude: (text) => {
    emitToClaude(systemMessage("a2a_inbound", text, "acp"));
  },
  log: (msg) => log(`[A2aGateway] ${msg}`),
});

// Daemon-side handler for ACP turn relay (P8.2 / P10.10).
// Takes a `gatewayForTarget` function instead of a fixed gateway
// so each inbound ACP turn resolves its own per-room gateway (keyed
// by TargetId) and inbound text routes only to that target's CC.
const acpTurnHandler = new AcpTurnHandler(
  async (target) => {
    const room = await inboundRoomRouter.getOrCreateByTarget(target as TargetId);
    return room.gateway;
  },
  (msg) => log(`[AcpTurnHandler] ${msg}`),
  {
    // P10.4 — only accept turns whose target has an attached CC
    // connection. Bare claude:default falls back to the legacy
    // "any attached CC" check so v0.1 single-attach setups keep
    // working when the subprocess doesn't send a target.
    isTargetAttached: (target) => {
      if (attachedClaudeByTarget.has(target)) return true;
      if (target === "claude:default" && attachedClaude !== null) return true;
      return false;
    },
  },
);

// One daemon-wide task log; every Room tracks through this shared store
// (rows are scoped by the room_id column).
const sharedTaskStore = SqliteTaskLog.open(stateDir.taskLogFile);

// Default Room owns the one Codex adapter the daemon spawns on boot
// (P4.8 — no module-level singleton). Non-default rooms share the
// gateway + store but don't spawn a peer adapter set of their own
// (single-CC v0.1). `adopt()` seeds the router so
// `getOrCreate(DEFAULT_ROOM_ID)` returns this same room.
const defaultRoom = new Room({
  id: DEFAULT_ROOM_ID,
  gateway: inboundGateway,
  registry: sharedTaskStore,
  peers: [new CodexAdapter(CODEX_APP_PORT, CODEX_PROXY_PORT)],
});
const codex = defaultRoom.getPeer("codex") as CodexAdapter;
const attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;
// P10.10 — each non-default Room gets its own gateway whose
// `sendToClaude` routes to the Room's TargetId via
// `emitToClaudeTarget`, so concurrent ACP turns for different
// targets deliver only to their own attached CC.
const inboundRoomRouter = new RoomRouter(
  (id) => {
    const roomGateway = new DaemonClaudeCodeGateway({
      sendToClaude: (text) =>
        emitToClaudeTarget(id as string, systemMessage("a2a_inbound", text, "acp")),
      log: (msg) => log(`[A2aGateway:${id}] ${msg}`),
    });
    return new Room({ id, gateway: roomGateway, registry: sharedTaskStore });
  },
);
inboundRoomRouter.adopt(defaultRoom);
let nextSystemMessageId = 0;
let codexBootstrapped = false;
let attentionWindowTimer: ReturnType<typeof setTimeout> | null = null;
let inAttentionWindow = false;
let replyRequired = false;
let replyReceivedDuringTurn = false;
let shuttingDown = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
let claudeDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
let claudeOnlineNoticeSent = false;
let claudeOfflineNoticeShown = false;
let lastAttachStatusSentTs = 0;
const ATTACH_STATUS_COOLDOWN_MS = 30_000; // Don't re-send status on rapid reattach

const bufferedMessages: BridgeMessage[] = [];

const tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    emitToClaude(
      systemMessage(
        "system_tui_disconnected",
        `⚠️ Codex TUI disconnected (conn #${connId}). Codex is still running in the background — reconnect the TUI to resume.`,
      ),
    );
  },
  onReconnectAfterNotice: (connId) => {
    emitToClaude(
      systemMessage(
        "system_tui_reconnected",
        `✅ Codex TUI reconnected (conn #${connId}). Bridge restored, communication can continue.`,
      ),
    );
    codex.injectMessage("✅ Claude Code is still online, bridge restored. Bidirectional communication can continue.");
  },
});

const statusBuffer = new StatusBuffer((summary) => emitToClaude(summary));

codex.on("turnStarted", () => {
  log("Codex turn started");
  emitToClaude(
    systemMessage(
      "system_turn_started",
      "⏳ Codex is working on the current task. Wait for completion before sending a reply.",
    ),
  );
});

codex.on("agentMessage", (msg: BridgeMessage) => {
  if (msg.source !== "codex") return;
  const result = classifyMessage(msg.content, FILTER_MODE);

  // When replyRequired is active, force-forward ALL messages regardless of marker
  if (replyRequired) {
    log(`Codex → Claude [${result.marker}/force-forward-reply-required] (${msg.content.length} chars)`);
    replyReceivedDuringTurn = true;
    if (statusBuffer.size > 0) {
      statusBuffer.flush("reply-required message arrived");
    }
    emitToClaude(msg);
    return;
  }

  // During attention window, suppress STATUS to give Claude space to respond
  if (inAttentionWindow && result.marker === "status") {
    log(`Codex → Claude [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
    statusBuffer.add(msg);
    return;
  }

  log(`Codex → Claude [${result.marker}/${result.action}] (${msg.content.length} chars)`);
  switch (result.action) {
    case "forward":
      if (result.marker === "important" && statusBuffer.size > 0) {
        statusBuffer.flush("important message arrived");
      }
      emitToClaude(msg);
      // IMPORTANT message — give Claude an attention window to respond
      if (result.marker === "important") {
        startAttentionWindow();
      }
      break;
    case "buffer":
      statusBuffer.add(msg);
      break;
    case "drop":
      break;
  }
});

codex.on("turnCompleted", () => {
  log("Codex turn completed");
  statusBuffer.flush("turn completed");

  // Check if reply was required but Codex didn't send any agentMessage
  if (replyRequired && !replyReceivedDuringTurn) {
    log("⚠️ Reply was required but Codex did not send any agentMessage");
    emitToClaude(
      systemMessage(
        "system_reply_missing",
        "⚠️ Codex completed the turn without sending a reply (require_reply was set). Codex may not have generated an agentMessage. You may want to retry or rephrase.",
      ),
    );
  }

  // Reset reply-required state
  replyRequired = false;
  replyReceivedDuringTurn = false;

  emitToClaude(
    systemMessage(
      "system_turn_completed",
      "✅ Codex finished the current turn. You can reply now if needed.",
    ),
  );
  startAttentionWindow();
});

codex.on("ready", (threadId: string) => {
  tuiConnectionState.markBridgeReady();
  log(`Codex ready — thread ${threadId}`);
  log("Bridge fully operational");

  emitToClaude(
    systemMessage("system_ready", currentReadyMessage()),
  );

  if (attachedClaude && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
});

codex.on("tuiConnected", (connId: number) => {
  tuiConnectionState.handleTuiConnected(connId);
  cancelIdleShutdown();
  log(`Codex TUI connected (conn #${connId})`);
  broadcastStatus();
});

codex.on("tuiDisconnected", (connId: number) => {
  tuiConnectionState.handleTuiDisconnected(connId);
  log(`Codex TUI disconnected (conn #${connId})`);
  broadcastStatus();
  scheduleIdleShutdown();
});

codex.on("error", (err: Error) => {
  log(`Codex error: ${err.message}`);
});

codex.on("exit", (code: number | null) => {
  log(`Codex process exited (code ${code})`);
  codexBootstrapped = false;
  statusBuffer.flush("codex exited");
  tuiConnectionState.handleCodexExit();
  clearPendingClaudeDisconnect("Codex process exited");
  claudeOnlineNoticeSent = false;
  claudeOfflineNoticeShown = false;
  emitToClaude(
    systemMessage(
      "system_codex_exit",
      `⚠️ Codex app-server exited (code ${code ?? "unknown"}). A2aBridge daemon is still running, but the Codex side needs to be restarted.`,
    ),
  );
  broadcastStatus();
});

async function startControlServer() {
  const listener = new WebSocketListener({
    port: CONTROL_PORT,
    hostname: process.env.A2A_BRIDGE_CONTROL_HOST ?? "127.0.0.1",
    path: "/ws",
    idleTimeoutSec: 960, // 16 minutes — prevent premature idle disconnects
    sendPings: true,
    httpHandler: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return Response.json(currentStatus());
      }
      if (url.pathname === "/readyz") {
        // The control plane is ready for ACP traffic as soon as it is
        // listening — codex bootstrapping is optional (v0.1 bridges
        // work without a Codex peer when only ACP inbound is used).
        return Response.json(currentStatus(), { status: 200 });
      }
      return undefined;
    },
  });

  listener.on("connection", (conn: Connection) => {
    const clientId = ++nextControlClientId;
    controlClientMeta.set(conn, { clientId, attached: false });
    log(`Frontend socket opened (#${clientId})`);

    conn.on("message", (raw) => {
      handleControlMessage(conn, raw);
    });

    conn.on("close", () => {
      const meta = controlClientMeta.get(conn);
      const wasAttached = attachedClaude === conn;
      log(`Frontend socket closed (#${meta?.clientId ?? "?"}, wasAttached=${wasAttached})`);
      if (wasAttached) {
        detachClaude(conn, "frontend socket closed");
      }
      acpTurnHandler.onConnectionClose(conn);
    });

    conn.on("error", (err) => {
      log(`Frontend socket error (#${clientId}): ${err.message}`);
    });
  });

  listener.on("error", (err) => {
    log(`Control listener error: ${err.message}`);
  });

  controlListener = listener;
  await listener.listen();
}

function handleControlMessage(conn: Connection, raw: string) {
  let message: ControlClientMessage;
  try {
    message = JSON.parse(raw);
  } catch (e: any) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }

  switch (message.type) {
    case "claude_connect":
      attachClaude(conn, message.target, message.force === true);
      return;
    case "claude_disconnect":
      detachClaude(conn, "frontend requested disconnect");
      return;
    case "status":
      sendStatus(conn);
      return;
    case "acp_turn_start":
      void acpTurnHandler.handleTurnStart(conn, message);
      return;
    case "acp_turn_cancel":
      acpTurnHandler.handleTurnCancel(conn, message);
      return;
    case "plugin_permission_request": {
      // Policy (architecture.md §"Permission-relay policy for ACP-originated
      // turns"): forward the verdict request to the ACP client that owns
      // the active turn; auto-deny when no ACP turn is active.
      const { requestId } = message;
      acpTurnHandler
        .routePermissionRequest({
          requestId,
          toolName: message.toolName,
          description: message.description,
          inputPreview: message.inputPreview,
        })
        .then((outcome) => {
          sendProtocolMessage(conn, {
            type: "plugin_permission_response",
            requestId,
            outcome,
          });
        })
        .catch((err: Error) => {
          log(`Permission routing failed for ${requestId}: ${err.message}`);
          sendProtocolMessage(conn, {
            type: "plugin_permission_response",
            requestId,
            outcome: "deny",
          });
        });
      return;
    }
    case "acp_permission_response":
      acpTurnHandler.handlePermissionResponse(conn, message);
      return;
    case "list_targets": {
      const entries = listTargetEntries();
      sendProtocolMessage(conn, {
        type: "targets_response",
        requestId: message.requestId,
        targets: entries,
      });
      return;
    }
    case "claude_to_codex": {
      if (message.message.source !== "claude") {
        sendProtocolMessage(conn, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Invalid message source",
        });
        return;
      }

      // P10.8 — optional `target` on the reply frame overrides default
      // routing. `claude:*` targets deliver to that attached CC via
      // `sendBridgeMessage`; `codex:default` falls through to today's
      // injection path; anything else is a routing error surfaced back
      // to the calling CC.
      if (message.target !== undefined) {
        const parsed = parseTarget(message.target);
        if (!parsed.ok) {
          sendProtocolMessage(conn, {
            type: "claude_to_codex_result",
            requestId: message.requestId,
            success: false,
            error: `Invalid target "${message.target}": ${parsed.error}`,
          });
          return;
        }
        const targetStr = parsed.target as unknown as string;
        if (parsed.parts.kind === "claude") {
          // Deliver directly to the named CC attach. Surface `claude:default`
          // via the legacy singleton when no explicit entry exists so v0.1
          // setups still round-trip a reply.
          const destConn =
            attachedClaudeByTarget.get(targetStr) ??
            (targetStr === "claude:default" ? attachedClaude : null);
          if (!destConn) {
            sendProtocolMessage(conn, {
              type: "claude_to_codex_result",
              requestId: message.requestId,
              success: false,
              error: `target ${targetStr} is not attached`,
            });
            return;
          }
          if (destConn === conn) {
            sendProtocolMessage(conn, {
              type: "claude_to_codex_result",
              requestId: message.requestId,
              success: false,
              error: `target ${targetStr} resolves to the sender — replies cannot loop back to self`,
            });
            return;
          }
          sendBridgeMessage(destConn, message.message);
          clearAttentionWindow();
          sendProtocolMessage(conn, {
            type: "claude_to_codex_result",
            requestId: message.requestId,
            success: true,
          });
          return;
        }
        if (parsed.parts.kind === "codex") {
          // Codex peer id routing lands in P10.9 — today's daemon only
          // hosts one Codex adapter, so only `codex:default` is valid.
          if (parsed.parts.id !== "default") {
            sendProtocolMessage(conn, {
              type: "claude_to_codex_result",
              requestId: message.requestId,
              success: false,
              error: `target ${targetStr} not recognized (only codex:default is supported until P10.9)`,
            });
            return;
          }
          // Fall through to the existing codex injection path below.
        } else {
          sendProtocolMessage(conn, {
            type: "claude_to_codex_result",
            requestId: message.requestId,
            success: false,
            error: `Unsupported target kind "${parsed.parts.kind}"`,
          });
          return;
        }
      }

      // If an A2A / ACP inbound turn is in flight for this CC's
      // target, the reply belongs to it (not Codex). P10.10: pick
      // the sender's per-target Room gateway so a reply from CC-A
      // can't accidentally complete CC-B's in-flight turn.
      const senderTarget = claudeConnTarget.get(conn) ?? "claude:default";
      const senderRoom = inboundRoomRouter.getByTarget(senderTarget as TargetId);
      const senderGateway =
        (senderRoom?.gateway as DaemonClaudeCodeGateway | undefined) ?? inboundGateway;
      if (senderGateway.interceptReply(message.message.content)) {
        log(
          `Claude reply consumed by inbound A2A/ACP turn on ${senderTarget} ` +
            `(${message.message.content.length} chars)`,
        );
        clearAttentionWindow();
        sendProtocolMessage(conn, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: true,
        });
        return;
      }

      if (!tuiConnectionState.canReply()) {
        sendProtocolMessage(conn, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: "Codex is not ready. Wait for TUI to connect and create a thread.",
        });
        return;
      }

      const requireReply = !!message.requireReply;
      let contentWithReminder = message.message.content + "\n\n" + BRIDGE_CONTRACT_REMINDER;
      if (requireReply) {
        contentWithReminder += REPLY_REQUIRED_INSTRUCTION;
        replyRequired = true;
        replyReceivedDuringTurn = false;
        log(`Reply required flag set for this message`);
      }
      log(`Forwarding Claude → Codex (${message.message.content.length} chars, requireReply=${requireReply})`);
      const injected = codex.injectMessage(contentWithReminder);
      if (!injected) {
        const reason = codex.turnInProgress
          ? "Codex is busy executing a turn. Wait for it to finish before sending another message."
          : "Injection failed: no active thread or WebSocket not connected.";
        log(`Injection rejected: ${reason}`);
        sendProtocolMessage(conn, {
          type: "claude_to_codex_result",
          requestId: message.requestId,
          success: false,
          error: reason,
        });
        return;
      }
      clearAttentionWindow(); // Claude successfully replied, end attention window
      sendProtocolMessage(conn, {
        type: "claude_to_codex_result",
        requestId: message.requestId,
        success: true,
      });
      return;
    }
  }
}

function attachClaude(conn: Connection, target?: string, force: boolean = false) {
  // P10.3 — accept an optional `kind:id` target so multiple CC
  // instances can attach to the same daemon. v0.1 frames omit the
  // target field; default it to the canonical `claude:default`.
  // Target validation lives in the parser (P10.1); reuse it so we
  // never let a malformed string into our maps.
  let resolvedTarget = "claude:default";
  if (target) {
    const parsed = parseTarget(target);
    if (!parsed.ok) {
      log(`Rejecting claude_connect with invalid target "${target}": ${parsed.error}`);
      sendProtocolMessage(conn, {
        type: "claude_connect_rejected",
        target,
        reason: `invalid target: ${parsed.error}`,
      });
      return;
    }
    if (parsed.parts.kind !== "claude") {
      log(`Rejecting claude_connect with non-claude target "${target}"`);
      sendProtocolMessage(conn, {
        type: "claude_connect_rejected",
        target,
        reason: `non-claude target rejected on claude_connect`,
      });
      return;
    }
    resolvedTarget = parsed.target as unknown as string;
  }

  // P10.6 — conflict policy. If a different connection already owns
  // this target, either reject the new attach (default) or kick the
  // old one (force=true). The existing `attachedClaudeByTarget`
  // entry is the single source of truth.
  const existing = attachedClaudeByTarget.get(resolvedTarget);
  if (existing && existing !== conn) {
    if (!force) {
      const existingMeta = controlClientMeta.get(existing);
      const attachedAt = attachedAtByTarget.get(resolvedTarget);
      const ageMs = attachedAt !== undefined ? Date.now() - attachedAt : null;
      const ageHint = ageMs !== null ? `, attached ${formatAttachAge(ageMs)}` : "";
      const connHint = existingMeta ? `plugin conn #${existingMeta.clientId}${ageHint}` : "unknown";
      const reason =
        `target ${resolvedTarget} already attached (${connHint}). ` +
        `Re-run with --force to take over, or use a different workspace id.`;
      log(`Rejecting claude_connect for ${resolvedTarget} — ${connHint}`);
      sendProtocolMessage(conn, {
        type: "claude_connect_rejected",
        target: resolvedTarget,
        reason,
      });
      return;
    }
    log(`Force-replacing existing attachment for ${resolvedTarget}`);
    // Tell the old attach it was kicked *before* closing its socket so
    // the plugin can push a notification to its CC session.
    sendProtocolMessage(existing, {
      type: "claude_connect_replaced",
      target: resolvedTarget,
    });
    existing.close();
  }
  attachedClaudeByTarget.set(resolvedTarget, conn);
  attachedAtByTarget.set(resolvedTarget, Date.now());
  claudeConnTarget.set(conn, resolvedTarget);

  const meta = controlClientMeta.get(conn);

  clearPendingClaudeDisconnect("Claude frontend attached");
  attachedClaude = conn;
  if (meta) meta.attached = true;
  cancelIdleShutdown();
  log(`Claude frontend attached (#${meta?.clientId ?? "?"}) → ${resolvedTarget}`);

  statusBuffer.flush("claude reconnected");
  sendStatus(conn);

  const now = Date.now();
  const isRapidReattach = now - lastAttachStatusSentTs < ATTACH_STATUS_COOLDOWN_MS;

  if (bufferedMessages.length > 0) {
    flushBufferedMessages(conn);
  } else if (!isRapidReattach) {
    // Only send status messages if this is not a rapid reattach (avoid flooding Claude)
    if (tuiConnectionState.canReply()) {
      sendBridgeMessage(conn, systemMessage("system_ready", currentReadyMessage()));
    } else if (codexBootstrapped) {
      sendBridgeMessage(conn, systemMessage("system_waiting", currentWaitingMessage()));
    }
  }

  lastAttachStatusSentTs = now;

  if (tuiConnectionState.canReply() && shouldNotifyCodexClaudeOnline()) {
    notifyCodexClaudeOnline();
  }
}

function detachClaude(conn: Connection, reason: string) {
  // Drop this conn from the per-target map regardless of whether it
  // is the global "attachedClaude" pointer — multi-target attaches
  // need cleanup either way.
  const target = claudeConnTarget.get(conn);
  if (target && attachedClaudeByTarget.get(target) === conn) {
    attachedClaudeByTarget.delete(target);
    attachedAtByTarget.delete(target);
  }
  claudeConnTarget.delete(conn);

  if (attachedClaude !== conn) return;

  const meta = controlClientMeta.get(conn);
  // Promote any other currently-attached CC to the global pointer so
  // emitToClaude / broadcast still has a destination. When nothing is
  // left, clear it. The next iteration order preserves "most recently
  // inserted survives".
  let nextAttached: Connection | null = null;
  for (const c of attachedClaudeByTarget.values()) nextAttached = c;
  attachedClaude = nextAttached;
  if (meta) meta.attached = false;
  log(`Claude frontend detached (#${meta?.clientId ?? "?"}, ${reason})`);

  scheduleClaudeDisconnectNotification(meta?.clientId ?? -1);

  scheduleIdleShutdown();
}

function startAttentionWindow() {
  clearAttentionWindow();
  inAttentionWindow = true;
  statusBuffer.pause();
  log(`Attention window started (${ATTENTION_WINDOW_MS}ms)`);
  attentionWindowTimer = setTimeout(() => {
    attentionWindowTimer = null;
    inAttentionWindow = false;
    statusBuffer.resume();
    log("Attention window ended");
  }, ATTENTION_WINDOW_MS);
}

function clearAttentionWindow() {
  if (attentionWindowTimer) {
    clearTimeout(attentionWindowTimer);
    attentionWindowTimer = null;
  }
  if (inAttentionWindow) {
    statusBuffer.resume();
  }
  inAttentionWindow = false;
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (attachedClaude) return; // still has a client

  const snapshot = tuiConnectionState.snapshot();
  if (snapshot.tuiConnected) return; // TUI still connected

  // Per-Room idle gate (P4.9): don't shut down if any Room has an
  // in-flight turn or outstanding tasks, even if no client is
  // currently attached.
  if (!inboundRoomRouter.allIdle) return;

  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    // Re-check before shutting down
    if (attachedClaude || tuiConnectionState.snapshot().tuiConnected) {
      log("Idle shutdown cancelled: client reconnected during grace period");
      return;
    }
    if (!inboundRoomRouter.allIdle) {
      log("Idle shutdown cancelled: a room became active during grace period");
      return;
    }
    shutdown("idle — no clients connected");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

function clearPendingClaudeDisconnect(reason?: string) {
  if (!claudeDisconnectTimer) return;
  clearTimeout(claudeDisconnectTimer);
  claudeDisconnectTimer = null;
  if (reason) {
    log(`Cleared pending Claude disconnect notification (${reason})`);
  }
}

function scheduleClaudeDisconnectNotification(clientId: number) {
  clearPendingClaudeDisconnect("rescheduled");
  claudeDisconnectTimer = setTimeout(() => {
    claudeDisconnectTimer = null;

    if (attachedClaude) {
      log(
        `Skipping Claude disconnect notification for client #${clientId} because Claude already reconnected`,
      );
      return;
    }

    if (!tuiConnectionState.canReply()) {
      log(
        `Suppressing Claude disconnect notification for client #${clientId} because Codex cannot reply`,
      );
      return;
    }

    if (!claudeOnlineNoticeSent) {
      log(
        `Suppressing Claude disconnect notification for client #${clientId} because Claude was never announced online`,
      );
      return;
    }

    codex.injectMessage(
      "⚠️ Claude Code went offline. A2aBridge is still running in the background; it will reconnect automatically when Claude reopens.",
    );
    claudeOnlineNoticeSent = false;
    claudeOfflineNoticeShown = true;
    log(`Claude disconnect persisted past grace window (client #${clientId})`);
  }, CLAUDE_DISCONNECT_GRACE_MS);
}

/**
 * P10.10 — target-aware delivery. Picks the Connection registered for
 * `target` in `attachedClaudeByTarget`; for `claude:default` we also
 * accept the legacy `attachedClaude` singleton so v0.1 setups that
 * didn't send a target field still receive inbound traffic. When no
 * CC is attached for the target, the message is dropped with a log —
 * callers (ACP turn handler) already gate on `isTargetAttached`, and
 * broadcast-style buffering across unrelated targets would leak data.
 */
function emitToClaudeTarget(target: string, message: BridgeMessage) {
  const dest =
    attachedClaudeByTarget.get(target) ??
    (target === "claude:default" ? attachedClaude : null);
  if (dest && dest.isOpen) {
    if (trySendBridgeMessage(dest, message)) return;
    log(`Send to ${target} failed — dropping message (buffering not per-target yet)`);
    return;
  }
  log(`No CC attached for ${target} — dropping inbound message`);
}

function emitToClaude(message: BridgeMessage) {
  if (attachedClaude && attachedClaude.isOpen) {
    if (trySendBridgeMessage(attachedClaude, message)) return;
    // Send failed — fall through to buffer
    log("Send to Claude failed, buffering message for retry on reconnect");
  }

  bufferedMessages.push(message);
  if (bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    bufferedMessages.splice(0, dropped);
    log(`Message buffer overflow: dropped ${dropped} oldest message(s), ${MAX_BUFFERED_MESSAGES} remaining`);
  }
}

function trySendBridgeMessage(conn: Connection, message: BridgeMessage): boolean {
  try {
    conn.send(JSON.stringify({ type: "codex_to_claude", message } satisfies ControlServerMessage));
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(conn: Connection) {
  const messages = bufferedMessages.splice(0, bufferedMessages.length);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (!trySendBridgeMessage(conn, message)) {
      // Re-buffer this and all remaining messages on failure
      const remaining = messages.slice(i);
      bufferedMessages.unshift(...remaining);
      log(`Flush interrupted: re-buffered ${remaining.length} message(s) after send failure`);
      return;
    }
  }
}

function sendBridgeMessage(conn: Connection, message: BridgeMessage) {
  trySendBridgeMessage(conn, message);
}

function sendStatus(conn: Connection) {
  sendProtocolMessage(conn, { type: "status", status: currentStatus() });
}

function broadcastStatus() {
  if (!attachedClaude) return;
  sendStatus(attachedClaude);
}

function sendProtocolMessage(conn: Connection, message: ControlServerMessage) {
  try {
    conn.send(JSON.stringify(message));
  } catch (err: any) {
    log(`Failed to send control message: ${err.message}`);
  }
}

function currentStatus(): DaemonStatus {
  const snapshot = tuiConnectionState.snapshot();
  return {
    bridgeReady: tuiConnectionState.canReply(),
    tuiConnected: snapshot.tuiConnected,
    threadId: codex.activeThreadId,
    queuedMessageCount: bufferedMessages.length + statusBuffer.size,
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    pid: process.pid,
  };
}

function currentWaitingMessage() {
  return `⏳ Waiting for Codex TUI to connect. Run in another terminal:\n${attachCmd}`;
}

function currentReadyMessage() {
  return `✅ Codex TUI connected (${codex.activeThreadId}). Bridge ready.`;
}

function notifyCodexClaudeOnline() {
  claudeOnlineNoticeSent = true;
  claudeOfflineNoticeShown = false;
  codex.injectMessage("✅ A2aBridge connected to Claude Code.");
}

function shouldNotifyCodexClaudeOnline() {
  return !claudeOnlineNoticeSent || claudeOfflineNoticeShown;
}

/**
 * Render a conflict-reject attach age like `2h ago` / `3m ago` / `9s ago`
 * for the human-readable `claude_connect_rejected.reason` string.
 */
function formatAttachAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function listTargetEntries() {
  // P10.5 — snapshot every TargetId the daemon currently tracks.
  // Today's daemon only knows about Claude attachments via
  // attachedClaudeByTarget; future Codex / Hermes peer adapters
  // will register their own targets through the same registry.
  const entries: import("@transport/control-protocol").TargetEntry[] = [];
  for (const [target, conn] of attachedClaudeByTarget.entries()) {
    const meta = controlClientMeta.get(conn);
    entries.push({
      target,
      attached: true,
      ...(meta ? { clientId: meta.clientId } : {}),
      ...(attachedAtByTarget.has(target) ? { attachedAt: attachedAtByTarget.get(target)! } : {}),
    });
  }
  // Surface the legacy `attachedClaude` singleton as `claude:default`
  // ONLY when no per-target attach already covers it. Without this
  // check we'd print a phantom `claude:default` row whenever any v0.2
  // attach lands (the singleton always tracks the most-recent attach,
  // so it aliases an already-listed per-target conn).
  if (attachedClaude && !attachedClaudeByTarget.has("claude:default")) {
    let alreadyListed = false;
    for (const conn of attachedClaudeByTarget.values()) {
      if (conn === attachedClaude) {
        alreadyListed = true;
        break;
      }
    }
    if (!alreadyListed) {
      const meta = controlClientMeta.get(attachedClaude);
      entries.push({
        target: "claude:default",
        attached: true,
        ...(meta ? { clientId: meta.clientId } : {}),
      });
    }
  }
  return entries;
}

function systemMessage(idPrefix: string, content: string, source: BridgeMessage["source"] = "codex"): BridgeMessage {
  return {
    id: `${idPrefix}_${++nextSystemMessageId}`,
    source,
    content,
    timestamp: Date.now(),
  };
}

function writePidFile() {
  daemonLifecycle.writePid();
}

function removePidFile() {
  daemonLifecycle.removePidFile();
}

function writeStatusFile() {
  daemonLifecycle.writeStatus({
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    controlPort: CONTROL_PORT,
    pid: process.pid,
  });
}

function removeStatusFile() {
  daemonLifecycle.removeStatusFile();
}

async function bootCodex() {
  log("Starting A2aBridge daemon...");
  log(`Codex app-server: ${codex.appServerUrl}`);
  log(`Codex proxy: ${codex.proxyUrl}`);
  log(`Control server: ws://${process.env.A2A_BRIDGE_CONTROL_HOST ?? "127.0.0.1"}:${CONTROL_PORT}/ws`);

  try {
    await codex.start();
    codexBootstrapped = true;
    writeStatusFile();

    emitToClaude(systemMessage("system_waiting", currentWaitingMessage()));
    broadcastStatus();
  } catch (err: any) {
    // Codex is optional — don't alarm the user if it's just not
    // installed. The ACP bridge works fine without Codex.
    const msg = err.message ?? String(err);
    log(`Codex start skipped: ${msg}`);
    if (!msg.includes("not found in $PATH") && !msg.includes("Executable not found")) {
      // Only push a notification for unexpected failures, not for
      // "codex binary missing" which is the normal bridge-only case.
      emitToClaude(
        systemMessage(
          "system_codex_start_failed",
          `⚠️ Codex app-server failed to start: ${msg}. The ACP bridge still works — Codex is optional.`,
        ),
      );
    }
    broadcastStatus();
  }
}

async function bootInbound() {
  if (!A2A_INBOUND_TOKEN) {
    log("A2A inbound disabled (set A2A_BRIDGE_BEARER_TOKEN to enable)");
    return;
  }

  // `A2A_BRIDGE_INBOUND_ECHO=1` is a **test/debug-only knob**: it swaps
  // the A2A HTTP inbound's Claude Code executor for an in-process echo
  // executor so the A2A wire contract can be exercised without a real
  // Claude Code session attached. `scripts/smoke-e2e.sh` uses it for its
  // A2A half; the ACP half attaches a real stub CC via DaemonClient and
  // does NOT depend on this hook.  Do not document this env var in any
  // user-facing runbook or advertise it as a production fallback — the
  // `a2a-bridge acp` subcommand fails loudly when the daemon has no CC
  // attached (P8.4).
  const echoMode = process.env.A2A_BRIDGE_INBOUND_ECHO === "1";
  const routedConfig = echoMode
    ? { messageStreamExecutor: createEchoExecutor() }
    : {
        roomRouter: inboundRoomRouter,
        executorFactory: (gateway: import("@daemon/inbound/a2a-http/claude-code-gateway").ClaudeCodeGateway) =>
          createClaudeCodeExecutor({ gateway }),
        // P10.7 — operator-supplied contextId → TargetId map. Format:
        // `A2A_BRIDGE_CONTEXT_ROUTES='{"ctx-alice":"claude:alice"}'`.
        // Malformed JSON is logged and the map is dropped so a typo
        // degrades to v0.1 routing rather than bringing A2A down.
        ...(parseContextRoutes(process.env.A2A_BRIDGE_CONTEXT_ROUTES, log) ?? {}),
      };

  try {
    a2aInboundServer = await startA2AServer({
      host: A2A_INBOUND_HOST,
      port: A2A_INBOUND_PORT,
      bearerToken: A2A_INBOUND_TOKEN,
      publicAgentCard: A2A_INBOUND_PUBLIC_CARD,
      agentCard: {
        url: `http://${A2A_INBOUND_HOST}:${A2A_INBOUND_PORT}/a2a`,
      },
      ...routedConfig,
      registry: sharedTaskStore,
      logger: (msg) => log(`[A2aInbound] ${msg}`),
    });
    log(
      `A2A inbound server listening on http://${A2A_INBOUND_HOST}:${A2A_INBOUND_PORT}${a2aInboundServer.rpcPath}${
        echoMode ? " (echo mode)" : ""
      }`,
    );
  } catch (err: any) {
    log(`Failed to start A2A inbound server: ${err?.message ?? err}`);
  }
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  clearPendingClaudeDisconnect(`daemon shutdown (${reason})`);
  void controlListener?.close();
  controlListener = null;
  void a2aInboundServer?.shutdown();
  a2aInboundServer = null;
  codex.stop();
  removePidFile();
  removeStatusFile();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { removePidFile(); removeStatusFile(); });
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [A2aBridgeDaemon] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(stateDir.logFile, line);
  } catch {}
}

// Refuse to start if user intentionally killed the daemon.
// This prevents stale auto-reconnect loops from relaunching us.
// Only `a2a-bridge codex` / `ensureRunning` clears the sentinel before launching.
if (daemonLifecycle.wasKilled()) {
  log("Killed sentinel found — daemon was intentionally stopped. Exiting immediately.");
  process.exit(0);
}

writePidFile();
void startControlServer();
void bootCodex();
void bootInbound();
