/**
 * `a2a-bridge daemon start | stop | status | logs` (P6.3).
 *
 * Thin wrappers over `DaemonLifecycle` and the state-dir helpers:
 * - `start` → `ensureRunning()` (idempotent; a2a-bridge always enables
 *   A2A inbound when `A2A_BRIDGE_BEARER_TOKEN` is set, matching the
 *   daemon's own detection).
 * - `stop` → reads the pid file and SIGTERMs the process; a follow-up
 *   SIGKILL after a short grace window via `lifecycle.kill()`.
 * - `status` → prints the pid, control port, and A2A/Codex endpoints
 *   from `status.json`.
 * - `logs` → prints the tail of `a2a-bridge.log` (full file when the
 *   path is shorter than the requested tail).
 *
 * Dependencies the tests override:
 *   `buildLifecycle`  — so tests inject a stub instead of touching the
 *                       real state-dir / daemon.
 *   `logReader`       — returns the tail of the log file.
 *   `kill`            — the SIGTERM delegator (defaults to
 *                       `lifecycle.kill`).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DaemonLifecycle } from "@shared/daemon-lifecycle";
import { StateDirResolver } from "@shared/state-dir";
import type {
  ControlClientMessage,
  ControlServerMessage,
  TargetEntry,
} from "@transport/control-protocol";
import { findPackageRoot } from "./pkg-root";

export type DaemonSubcommand = "start" | "stop" | "status" | "logs" | "targets";

export interface LifecycleView {
  healthUrl: string;
  readyUrl: string;
  controlWsUrl: string;
  ensureRunning(): Promise<void>;
  readPid(): number | null;
  readStatus(): Record<string, unknown> | null;
  kill(gracefulTimeoutMs?: number): Promise<boolean>;
  readonly stateDir: StateDirResolver;
}

export interface RunDaemonOptions {
  buildLifecycle?: () => LifecycleView;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  /** Override for `logs` — returns the tail of the log file. */
  readLogTail?: (path: string, lines: number) => string | null;
  /** Override for `stop` graceful-kill window. Defaults to 3 seconds. */
  killTimeoutMs?: number;
  /**
   * Override for `targets` — opens a WebSocket to the control plane,
   * sends `list_targets`, and resolves with the daemon's snapshot.
   * Tests inject a stub so they don't have to spin a real daemon.
   */
  queryTargets?: (controlWsUrl: string) => Promise<TargetEntry[]>;
}

export interface RunDaemonResult {
  exitCode: number;
}

export async function runDaemon(
  args: string[],
  options: RunDaemonOptions = {},
): Promise<RunDaemonResult> {
  const sub = (args[0] as DaemonSubcommand | undefined) ?? undefined;
  const rest = args.slice(1);
  const log = options.log ?? ((m: string) => console.log(m));
  const error = options.error ?? ((m: string) => console.error(m));

  if (!sub || !["start", "stop", "status", "logs", "targets"].includes(sub)) {
    error(
      `Usage: a2a-bridge daemon <start|stop|status|logs|targets>\n` +
        `  daemon start    Launch the daemon (no-op if already running)\n` +
        `  daemon stop     Send SIGTERM via the pid file\n` +
        `  daemon status   Print the running daemon's pid + ports\n` +
        `  daemon logs     Tail the state-dir log file\n` +
        `  daemon targets  List every TargetId Room the daemon tracks`,
    );
    return { exitCode: sub ? 1 : 2 };
  }

  const lifecycle = (options.buildLifecycle ?? defaultLifecycle)();

  switch (sub) {
    case "start":
      try {
        await lifecycle.ensureRunning();
        const pid = lifecycle.readPid();
        log(`daemon started (pid ${pid ?? "unknown"})`);
        return { exitCode: 0 };
      } catch (err) {
        error(`daemon start failed: ${err instanceof Error ? err.message : String(err)}`);
        return { exitCode: 1 };
      }

    case "stop": {
      const pidBefore = lifecycle.readPid();
      if (pidBefore === null) {
        log("daemon is not running (no pid file)");
        return { exitCode: 0 };
      }
      const killed = await lifecycle.kill(options.killTimeoutMs ?? 3000);
      log(killed ? `daemon stopped (pid ${pidBefore})` : `daemon stop failed (pid ${pidBefore})`);
      return { exitCode: killed ? 0 : 1 };
    }

    case "status": {
      const pid = lifecycle.readPid();
      const status = lifecycle.readStatus();
      if (!pid && !status) {
        log("daemon is not running");
        return { exitCode: 0 };
      }
      log(`pid:          ${pid ?? "unknown"}`);
      if (status?.controlPort)
        log(`control port: ${String(status.controlPort)}`);
      if (status?.proxyUrl) log(`codex proxy:  ${String(status.proxyUrl)}`);
      if (status?.appServerUrl)
        log(`app-server:   ${String(status.appServerUrl)}`);
      if (status?.threadId) log(`thread id:    ${String(status.threadId)}`);
      log(`health:       ${lifecycle.healthUrl}`);
      log(`control ws:   ${lifecycle.controlWsUrl}`);
      return { exitCode: 0 };
    }

    case "logs": {
      const tailLines = parseTailArg(rest) ?? 200;
      const path = lifecycle.stateDir.logFile;
      const reader = options.readLogTail ?? defaultReadLogTail;
      const tail = reader(path, tailLines);
      if (tail === null) {
        error(`log file not found: ${path}`);
        return { exitCode: 1 };
      }
      log(tail);
      return { exitCode: 0 };
    }

    case "targets": {
      const pid = lifecycle.readPid();
      if (pid === null) {
        log("daemon is not running (no pid file)");
        return { exitCode: 0 };
      }
      const query = options.queryTargets ?? defaultQueryTargets;
      let entries: TargetEntry[];
      try {
        entries = await query(lifecycle.controlWsUrl);
      } catch (err) {
        error(`daemon targets failed: ${err instanceof Error ? err.message : String(err)}`);
        return { exitCode: 1 };
      }
      log(formatTargetsTable(entries));
      return { exitCode: 0 };
    }

    default:
      return { exitCode: 2 };
  }
}

/** ---------- defaults ---------- */

function defaultLifecycle(): LifecycleView {
  const stateDir = new StateDirResolver();
  const controlPort = parseInt(process.env.A2A_BRIDGE_CONTROL_PORT ?? "4512", 10);
  // Resolve the daemon bundle from the installed package root so
  // `a2a-bridge daemon start` works from the global npm install.
  let daemonEntryPath: string | undefined;
  try {
    daemonEntryPath = join(findPackageRoot(), "plugins", "a2a-bridge", "server", "daemon.js");
  } catch {}
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: () => {},
    daemonEntryPath,
  });
  // `DaemonLifecycle` keeps `stateDir` private; expose it via this
  // wrapper so the view's logs subcommand can reach the log file path.
  return {
    healthUrl: lifecycle.healthUrl,
    readyUrl: lifecycle.readyUrl,
    controlWsUrl: lifecycle.controlWsUrl,
    ensureRunning: () => lifecycle.ensureRunning(),
    readPid: () => lifecycle.readPid(),
    readStatus: () => lifecycle.readStatus() as Record<string, unknown> | null,
    kill: (timeout) => lifecycle.kill(timeout),
    stateDir,
  };
}

function defaultReadLogTail(path: string, lines: number): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const split = text.split("\n");
  const keep = split.slice(Math.max(0, split.length - lines - 1));
  return keep.join("\n").trimEnd();
}

function parseTailArg(args: string[]): number | null {
  const idx = args.findIndex((a) => a === "--tail" || a === "-n");
  if (idx === -1) return null;
  const raw = args[idx + 1];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

/**
 * Default `queryTargets` implementation: opens a WebSocket to the
 * control plane, sends `list_targets`, awaits `targets_response`, and
 * closes the socket.
 */
export async function defaultQueryTargets(controlWsUrl: string): Promise<TargetEntry[]> {
  return new Promise<TargetEntry[]>((resolve, reject) => {
    const requestId = `targets_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const ws = new WebSocket(controlWsUrl);
    let settled = false;
    const settle = (err: Error | null, value?: TargetEntry[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(value ?? []);
    };
    const timer = setTimeout(() => {
      settle(new Error(`Timed out waiting for targets_response from ${controlWsUrl}`));
    }, 5000);
    ws.onopen = () => {
      const frame: ControlClientMessage = { type: "list_targets", requestId };
      ws.send(JSON.stringify(frame));
    };
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      let msg: ControlServerMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "targets_response" && msg.requestId === requestId) {
        settle(null, msg.targets);
      }
    };
    ws.onerror = () => {
      settle(new Error(`Failed to connect to daemon control plane at ${controlWsUrl}`));
    };
    ws.onclose = () => {
      settle(new Error(`Daemon control plane closed before targets_response (${controlWsUrl})`));
    };
  });
}

/**
 * Format a `TargetEntry[]` snapshot as a 4-column plain-text table
 * (target, attached, client, uptime). "uptime" is wall-clock since
 * `attachedAt`, formatted as `Xs` / `Xm` / `Xh`.
 */
export function formatTargetsTable(entries: TargetEntry[], now: number = Date.now()): string {
  if (entries.length === 0) return "no targets registered";
  const header = ["TARGET", "ATTACHED", "CLIENT", "UPTIME"] as const;
  const rows: string[][] = [header.slice()];
  for (const entry of entries) {
    const attached = entry.attached ? "yes" : "no";
    const client = entry.clientId !== undefined ? String(entry.clientId) : "-";
    const uptime = entry.attachedAt !== undefined ? formatUptime(now - entry.attachedAt) : "-";
    rows.push([entry.target, attached, client, uptime]);
  }
  const widths = header.map((_, col) =>
    rows.reduce((w, row) => Math.max(w, row[col]!.length), 0),
  );
  return rows
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd())
    .join("\n");
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}
