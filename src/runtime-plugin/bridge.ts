#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import { ClaudeAdapter } from "@plugin/claude-channel/claude-adapter";
import { DaemonClient } from "@plugin/daemon-client/daemon-client";
import { DaemonLifecycle } from "@shared/daemon-lifecycle";
import { StateDirResolver } from "@shared/state-dir";
import { ConfigService } from "@shared/config-service";
import { resolveClaudeTarget } from "@shared/workspace-id";
import type { BridgeMessage } from "@messages/types";

const stateDir = new StateDirResolver();
const configService = new ConfigService();
const config = configService.loadOrDefault();

const CONTROL_PORT = parseInt(process.env.A2A_BRIDGE_CONTROL_PORT ?? "4512", 10);
const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });
const CONTROL_WS_URL = daemonLifecycle.controlWsUrl;

const claude = new ClaudeAdapter();
const daemonClient = new DaemonClient(CONTROL_WS_URL);

// P10.2 — derive this CC's TargetId from env + state-dir so the
// daemon can route inbound traffic to the right Room when multiple
// CC instances share one daemon. v0.1 backward compat: bare
// `claude` always resolves to `claude:default` when no env vars set.
const CLAUDE_TARGET = resolveClaudeTarget({ stateDirPath: stateDir.dir });

// P10.6 — `a2a-bridge claude --force` / `A2A_BRIDGE_FORCE_ATTACH=1`
// kicks an existing CC attached to the same TargetId. Read once at
// startup so operator intent is clear and can't race a reconnect.
const FORCE_ATTACH = process.env.A2A_BRIDGE_FORCE_ATTACH === "1";

let shuttingDown = false;
let daemonDisabled = false;

// --- Notification throttling for reconnect loops ---
const RECONNECT_NOTIFY_COOLDOWN_MS = 30_000; // Only notify once per 30s window
const DISABLED_RECOVERY_INTERVAL_MS = 5_000;
let lastDisconnectNotifyTs = 0;
let lastReconnectNotifyTs = 0;
let disabledRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let disabledRecoveryInFlight = false;

claude.setReplySender(async (msg: BridgeMessage, requireReply?: boolean, target?: string) => {
  if (msg.source !== "claude") {
    return { success: false, error: "Invalid message source" };
  }

  if (daemonDisabled) {
    return {
      success: false,
      error: "A2aBridge is disabled by `a2a-bridge kill`. Restart Claude Code (`a2a-bridge claude`), switch to a new conversation, or run `/resume` to reconnect.",
    };
  }

  return daemonClient.sendReply(msg, requireReply, target);
});

daemonClient.on("codexMessage", (message) => {
  log(`Forwarding daemon → Claude (${message.content.length} chars)`);
  void claude.pushNotification(message);
});

daemonClient.on("status", (status) => {
  log(
    `Daemon status: ready=${status.bridgeReady} tui=${status.tuiConnected} thread=${status.threadId ?? "none"} queued=${status.queuedMessageCount}`,
  );
});

// P10.6 — conflict outcomes on the multi-target attach path. In both
// cases the daemon won't serve this CC any further, so stop looping
// and surface the situation to the user via a CC notification.
daemonClient.on("connectRejected", ({ target, reason }) => {
  void enterDisabledState(
    `claude_connect rejected for ${target}: ${reason}`,
    `⛔ A2aBridge attach rejected for target ${target}. ${reason}`,
  );
});
daemonClient.on("connectReplaced", ({ target }) => {
  void enterDisabledState(
    `claude_connect replaced on ${target} — another CC took over with --force`,
    `⛔ A2aBridge attach for ${target} was replaced by another CC (--force). This bridge is now idle.`,
  );
});

daemonClient.on("disconnect", () => {
  if (shuttingDown || daemonDisabled) return;

  log("Daemon control connection closed — will attempt to reconnect");

  const now = Date.now();
  if (now - lastDisconnectNotifyTs >= RECONNECT_NOTIFY_COOLDOWN_MS) {
    lastDisconnectNotifyTs = now;
    void claude.pushNotification(systemMessage(
      "system_daemon_disconnected",
      "⚠️ A2aBridge daemon control connection lost. Attempting to reconnect...",
    ));
  } else {
    log("Suppressing duplicate disconnect notification (within cooldown)");
  }
  void reconnectToDaemon();
});

claude.on("ready", async () => {
  log(`MCP server ready (delivery mode: ${claude.getDeliveryMode()}) — ensuring A2aBridge daemon...`);
  if (daemonLifecycle.wasKilled()) {
    await enterDisabledState(
      "Killed sentinel found — bridge staying idle",
      "⛔ A2aBridge was stopped by `a2a-bridge kill`. Bridge is staying idle. Restart Claude Code (`a2a-bridge claude`), switch to a new conversation, or run `/resume` to reconnect.",
    );
    return;
  }
  await connectToDaemon();
});

async function connectToDaemon(isReconnect = false) {
  if (daemonDisabled) {
    log("connectToDaemon() skipped — bridge is disabled");
    return;
  }

  try {
    await daemonLifecycle.ensureRunning();
    await daemonClient.connect();
    daemonClient.attachClaude(CLAUDE_TARGET, FORCE_ATTACH);
    if (!isReconnect) {
      void claude.pushNotification(systemMessage(
        "system_bridge_ready",
        "✅ A2aBridge bridge is ready. Daemon connected. ACP clients can now send prompts.",
      ));
    }
  } catch (err: any) {
    log(`Failed to connect to daemon: ${err.message}`);
    await claude.pushNotification(
      systemMessage(
        "system_daemon_connect_failed",
        `❌ A2aBridge daemon failed to start or is unreachable: ${err.message}`,
      ),
    );
    throw err;
  }
}

async function enterDisabledState(logMessage: string, notificationContent: string) {
  if (daemonDisabled) return;

  daemonDisabled = true;
  log(logMessage);
  await claude.pushNotification(systemMessage("system_bridge_disabled", notificationContent));
  await daemonClient.disconnect();
  startDisabledRecoveryPoller();
}

const MAX_RECONNECT_DELAY_MS = 30_000;
let reconnectTask: Promise<void> | null = null;

async function notifyIfDaemonKilled(logMessage: string) {
  if (!daemonLifecycle.wasKilled()) return false;

  await enterDisabledState(
    logMessage,
    "⛔ A2aBridge was stopped by `a2a-bridge kill`. Bridge is staying idle. Restart Claude Code (`a2a-bridge claude`), switch to a new conversation, or run `/resume` to reconnect.",
  );
  return true;
}

function reconnectToDaemon(): Promise<void> {
  if (shuttingDown || daemonDisabled) return Promise.resolve();

  if (reconnectTask) {
    log("Skipping reconnect — another reconnect is already in progress");
    return reconnectTask;
  }

  reconnectTask = (async () => {
    try {
      for (let attempt = 0; !shuttingDown; attempt += 1) {
        if (await notifyIfDaemonKilled("Daemon was intentionally killed by user (killed sentinel found) — not reconnecting")) {
          return;
        }

        const delayMs = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
        if (attempt > 0) {
          log(`Reconnect attempt ${attempt + 1}, waiting ${delayMs}ms...`);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        if (shuttingDown) return;

        // Re-check after the backoff delay. The killed sentinel may be written
        // after the disconnect event fires but before the reconnect attempt runs.
        if (await notifyIfDaemonKilled("Daemon was intentionally killed during reconnect backoff — not reconnecting")) {
          return;
        }

        try {
          await connectToDaemon(true);
          log("Reconnected to A2aBridge daemon successfully");

          const now = Date.now();
          if (now - lastReconnectNotifyTs >= RECONNECT_NOTIFY_COOLDOWN_MS) {
            lastReconnectNotifyTs = now;
            void claude.pushNotification(systemMessage(
              "system_daemon_reconnected",
              "✅ A2aBridge daemon reconnected successfully.",
            ));
          } else {
            log("Suppressing duplicate reconnect notification (within cooldown)");
          }
          return;
        } catch {
          // Continue retrying with exponential backoff until shutdown or killed sentinel.
        }
      }
    } finally {
      reconnectTask = null;
    }
  })();

  return reconnectTask;
}

function startDisabledRecoveryPoller() {
  if (disabledRecoveryTimer || shuttingDown) return;

  log(`Starting disabled-state recovery poller (${DISABLED_RECOVERY_INTERVAL_MS}ms)`);
  disabledRecoveryTimer = setInterval(() => {
    void pollDisabledRecovery();
  }, DISABLED_RECOVERY_INTERVAL_MS);
}

function stopDisabledRecoveryPoller() {
  if (!disabledRecoveryTimer) return;

  clearInterval(disabledRecoveryTimer);
  disabledRecoveryTimer = null;
  disabledRecoveryInFlight = false;
  log("Stopped disabled-state recovery poller");
}

async function pollDisabledRecovery() {
  if (!daemonDisabled || shuttingDown || disabledRecoveryInFlight) return;

  disabledRecoveryInFlight = true;
  try {
    if (daemonLifecycle.wasKilled()) {
      return;
    }

    const healthy = await daemonLifecycle.isHealthy();
    if (!healthy) {
      return;
    }

    log("Disabled-state recovery conditions met — attempting direct daemon reconnect");
    try {
      await daemonClient.connect();
      // Recovery never forces — it's an automatic reconnect, not an
      // operator-initiated takeover. Pass `CLAUDE_TARGET` so the
      // daemon keeps the same Room it did on the initial attach.
      daemonClient.attachClaude(CLAUDE_TARGET);
      daemonDisabled = false;
      stopDisabledRecoveryPoller();
      void claude.pushNotification(systemMessage(
        "system_bridge_recovered",
        "✅ A2aBridge recovered after the killed sentinel was cleared. Daemon reconnected.",
      ));
    } catch (err: any) {
      log(`Disabled-state direct reconnect failed: ${err.message}`);
      daemonDisabled = false;
      stopDisabledRecoveryPoller();
      void reconnectToDaemon();
    }
  } finally {
    disabledRecoveryInFlight = false;
  }
}

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${Date.now()}`,
    source: "codex",
    content,
    timestamp: Date.now(),
  };
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down Claude frontend (${reason})...`);
  stopDisabledRecoveryPoller();
  const hardExit = setTimeout(() => {
    log("Shutdown timed out waiting for daemon disconnect; forcing exit");
    process.exit(0);
  }, 3000);

  void daemonClient.disconnect().finally(() => {
    clearTimeout(hardExit);
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.on("exit", () => {
  if (shuttingDown) return;
  void daemonClient.disconnect();
});
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [A2aBridgeFrontend] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(stateDir.logFile, line);
  } catch {}
}

log(`Starting A2aBridge frontend (daemon ws ${CONTROL_WS_URL})`);

(async () => {
  try {
    await claude.start();
  } catch (err: any) {
    log(`Fatal: failed to start MCP server: ${err.message}`);
  }
})();
