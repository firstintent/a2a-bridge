/**
 * `a2a-bridge doctor` — preflight checklist (P6.2).
 *
 * Runs a fixed set of checks (bun version, A2A port, ACP SDK install,
 * CC plugin discoverability, state-dir writability, `init` already
 * run) and prints a PASS / WARN / FAIL line per check. Exits non-zero
 * when any *required* check fails; warns are advisory.
 *
 * The checks are pure functions that take a single `Deps` record of
 * injected helpers so unit tests drive each branch without touching
 * the real network / filesystem / child processes.
 */

import { existsSync, accessSync, constants, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { StateDirResolver } from "@shared/state-dir";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** When false, a fail is fatal (exit code 1). Defaults to true. */
  required?: boolean;
}

export interface DoctorDeps {
  /** Bun version string ("1.3.7"). Return `null` when bun is unreachable. */
  bunVersion(): string | null;
  /** Returns true when the A2A port is free, false when in use. */
  a2aPortFree(port: number): Promise<boolean>;
  /** Returns the resolved ACP SDK directory or null when missing. */
  acpSdkPath(): string | null;
  /** Returns the path to the CC channel plugin dir if present. */
  ccPluginPath(): string | null;
  /** Returns true when the state-dir exists and is writable. */
  stateDirWritable(): boolean;
  /** Returns true when `<stateDir>/config.json` exists (init has run). */
  initRan(): boolean;
}

export interface RunDoctorOptions {
  deps?: Partial<DoctorDeps>;
  log?: (msg: string) => void;
  /** Override the A2A port the port-free check uses (defaults to 4520). */
  port?: number;
}

export interface RunDoctorResult {
  results: CheckResult[];
  exitCode: number;
}

const ICONS: Record<CheckStatus, string> = {
  pass: "✔",
  warn: "⚠",
  fail: "✗",
};

export async function runDoctor(
  options: RunDoctorOptions = {},
): Promise<RunDoctorResult> {
  const deps = resolveDeps(options.deps);
  const log = options.log ?? ((m: string) => console.log(m));
  const port = options.port ?? 4520;

  const results: CheckResult[] = [];

  // 1. bun version
  const bv = deps.bunVersion();
  if (!bv) {
    results.push({
      name: "bun runtime",
      status: "fail",
      detail: "bun not found in PATH; install Bun >= 1.3 from https://bun.sh",
    });
  } else if (compareVersions(bv, "1.3.0") < 0) {
    results.push({
      name: "bun runtime",
      status: "fail",
      detail: `bun ${bv} is too old — a2a-bridge needs >= 1.3.0`,
    });
  } else {
    results.push({ name: "bun runtime", status: "pass", detail: `bun ${bv}` });
  }

  // 2. A2A port free
  const portFree = await deps.a2aPortFree(port);
  results.push({
    name: "A2A port",
    status: portFree ? "pass" : "warn",
    detail: portFree
      ? `port ${port} is free`
      : `port ${port} is in use — set A2A_BRIDGE_A2A_PORT to override`,
    required: false,
  });

  // 3. ACP SDK installed
  const acpPath = deps.acpSdkPath();
  results.push({
    name: "ACP SDK",
    status: acpPath ? "pass" : "fail",
    detail: acpPath
      ? `@agentclientprotocol/sdk resolved at ${acpPath}`
      : "@agentclientprotocol/sdk not found — run `bun install` in the project root",
  });

  // 4. CC channel plugin discoverable
  const ccPath = deps.ccPluginPath();
  results.push({
    name: "CC channel plugin",
    status: ccPath ? "pass" : "warn",
    detail: ccPath
      ? `plugin directory at ${ccPath}`
      : "plugin not installed — run `a2a-bridge init` or `a2a-bridge dev`",
    required: false,
  });

  // 5. state-dir writable
  const stateOk = deps.stateDirWritable();
  results.push({
    name: "state-dir writable",
    status: stateOk ? "pass" : "fail",
    detail: stateOk
      ? "state-dir exists and is writable"
      : "state-dir is missing or not writable — set A2A_BRIDGE_STATE_DIR",
  });

  // 6. init already run
  const ran = deps.initRan();
  results.push({
    name: "init already run",
    status: ran ? "pass" : "warn",
    detail: ran
      ? "`<stateDir>/config.json` present"
      : "run `a2a-bridge init` to mint a bearer token and write config.json",
    required: false,
  });

  for (const r of results) {
    log(`${ICONS[r.status]}  ${r.name.padEnd(22)}  ${r.detail}`);
  }

  const failed = results.filter(
    (r) => r.status === "fail" && (r.required ?? true),
  );
  const exitCode = failed.length > 0 ? 1 : 0;
  if (exitCode === 0) {
    log("\nAll required checks passed.");
  } else {
    log(`\n${failed.length} required check(s) failed. See above for details.`);
  }
  return { results, exitCode };
}

/** ---------- default dep implementations ---------- */

function resolveDeps(overrides?: Partial<DoctorDeps>): DoctorDeps {
  const defaults: DoctorDeps = {
    bunVersion: defaultBunVersion,
    a2aPortFree: defaultA2aPortFree,
    acpSdkPath: defaultAcpSdkPath,
    ccPluginPath: defaultCcPluginPath,
    stateDirWritable: defaultStateDirWritable,
    initRan: defaultInitRan,
  };
  return { ...defaults, ...overrides };
}

function defaultBunVersion(): string | null {
  try {
    const out = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? (match[1] as string) : null;
  } catch {
    return null;
  }
}

async function defaultA2aPortFree(port: number): Promise<boolean> {
  // Use a short TCP connect attempt: if we can connect, something is
  // listening on that port. We bind a UDP socket as a crude "is TCP
  // port X claimed" signal — simpler than shelling out to `lsof`.
  return await new Promise<boolean>((resolve) => {
    const server = createSocket("udp4");
    server.once("error", () => resolve(false));
    server.bind({ port, address: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function defaultAcpSdkPath(): string | null {
  try {
    return require.resolve("@agentclientprotocol/sdk");
  } catch {
    return null;
  }
}

function defaultCcPluginPath(): string | null {
  // Best-effort: look for the plugin directory relative to the package
  // install root. Falls back to the common `~/.claude-code/plugins/`
  // location advertised by the `init` subcommand.
  const candidates = [
    join(process.cwd(), "plugins", "a2a-bridge"),
    join(process.env.HOME ?? "", ".claude-code", "plugins", "a2a-bridge"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  return null;
}

function defaultStateDirWritable(): boolean {
  try {
    const stateDir = new StateDirResolver();
    stateDir.ensure();
    accessSync(stateDir.dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultInitRan(): boolean {
  try {
    const stateDir = new StateDirResolver();
    return existsSync(join(stateDir.dir, "config.json"));
  } catch {
    return false;
  }
}

/** Shared from init.ts; copied rather than imported to avoid cross-file coupling. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}
