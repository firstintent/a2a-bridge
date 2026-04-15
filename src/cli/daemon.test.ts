import { describe, test, expect } from "bun:test";
import { runDaemon, formatTargetsTable, type LifecycleView } from "./daemon";
import { StateDirResolver } from "@shared/state-dir";
import type { TargetEntry } from "@transport/control-protocol";

class StubLifecycle implements LifecycleView {
  healthUrl = "http://127.0.0.1:4512/healthz";
  readyUrl = "http://127.0.0.1:4512/readyz";
  controlWsUrl = "ws://127.0.0.1:4512/ws";
  stateDir = new StateDirResolver("/tmp/stub-daemon");
  ensureRunningCalls = 0;
  killCalls = 0;
  private pid: number | null;
  private status: Record<string, unknown> | null;
  private killResult: boolean;
  private ensureError: Error | null;

  constructor(opts: {
    pid?: number | null;
    status?: Record<string, unknown> | null;
    killResult?: boolean;
    ensureError?: Error | null;
  } = {}) {
    this.pid = opts.pid ?? null;
    this.status = opts.status ?? null;
    this.killResult = opts.killResult ?? true;
    this.ensureError = opts.ensureError ?? null;
  }

  async ensureRunning(): Promise<void> {
    this.ensureRunningCalls += 1;
    if (this.ensureError) throw this.ensureError;
    if (this.pid === null) this.pid = 42424;
  }
  readPid(): number | null {
    return this.pid;
  }
  readStatus(): Record<string, unknown> | null {
    return this.status;
  }
  async kill(_timeoutMs?: number): Promise<boolean> {
    this.killCalls += 1;
    if (this.killResult) this.pid = null;
    return this.killResult;
  }
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    log: (m: string) => out.push(m),
    error: (m: string) => err.push(m),
    out,
    err,
  };
}

describe("runDaemon", () => {
  test("start invokes ensureRunning and prints the pid", async () => {
    const lc = new StubLifecycle({ pid: null });
    const sink = capture();
    const res = await runDaemon(["start"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
    });
    expect(res.exitCode).toBe(0);
    expect(lc.ensureRunningCalls).toBe(1);
    expect(sink.out.join("\n")).toMatch(/daemon started \(pid 42424\)/);
  });

  test("start surfaces ensureRunning errors as exit 1", async () => {
    const lc = new StubLifecycle({ ensureError: new Error("can't bind") });
    const sink = capture();
    const res = await runDaemon(["start"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
    });
    expect(res.exitCode).toBe(1);
    expect(sink.err.join("\n")).toMatch(/daemon start failed: can't bind/);
  });

  test("stop without a pid file is a clean no-op", async () => {
    const lc = new StubLifecycle({ pid: null });
    const sink = capture();
    const res = await runDaemon(["stop"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
    });
    expect(res.exitCode).toBe(0);
    expect(lc.killCalls).toBe(0);
    expect(sink.out.join("\n")).toMatch(/not running \(no pid file\)/);
  });

  test("stop calls kill and reports the previous pid", async () => {
    const lc = new StubLifecycle({ pid: 12345 });
    const sink = capture();
    const res = await runDaemon(["stop"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
    });
    expect(res.exitCode).toBe(0);
    expect(lc.killCalls).toBe(1);
    expect(sink.out.join("\n")).toMatch(/daemon stopped \(pid 12345\)/);
  });

  test("stop returns exit 1 when kill fails", async () => {
    const lc = new StubLifecycle({ pid: 123, killResult: false });
    const sink = capture();
    const res = await runDaemon(["stop"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
    });
    expect(res.exitCode).toBe(1);
  });

  test("status with no pid and no status file reports not running", async () => {
    const lc = new StubLifecycle({});
    const sink = capture();
    const res = await runDaemon(["status"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
    });
    expect(res.exitCode).toBe(0);
    expect(sink.out.join("\n")).toMatch(/not running/);
  });

  test("status prints pid + known status fields", async () => {
    const lc = new StubLifecycle({
      pid: 9001,
      status: {
        controlPort: 4512,
        proxyUrl: "http://127.0.0.1:5566",
        appServerUrl: "http://127.0.0.1:5567",
        threadId: "thread-abc",
      },
    });
    const sink = capture();
    const res = await runDaemon(["status"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
    });
    expect(res.exitCode).toBe(0);
    const joined = sink.out.join("\n");
    expect(joined).toMatch(/pid:\s+9001/);
    expect(joined).toMatch(/control port:\s+4512/);
    expect(joined).toMatch(/codex proxy:\s+http:\/\/127\.0\.0\.1:5566/);
    expect(joined).toMatch(/thread id:\s+thread-abc/);
    expect(joined).toMatch(/health:\s+http:\/\/127\.0\.0\.1:4512\/healthz/);
  });

  test("logs returns exit 1 when the log file is absent", async () => {
    const lc = new StubLifecycle({});
    const sink = capture();
    const res = await runDaemon(["logs"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
      readLogTail: () => null,
    });
    expect(res.exitCode).toBe(1);
    expect(sink.err.join("\n")).toMatch(/log file not found/);
  });

  test("logs honours --tail N and prints what the reader returned", async () => {
    const lc = new StubLifecycle({});
    const sink = capture();
    const seen: number[] = [];
    const res = await runDaemon(["logs", "--tail", "25"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
      readLogTail: (_path, n) => {
        seen.push(n);
        return "[2026-04-13] boot\n[2026-04-13] ready";
      },
    });
    expect(res.exitCode).toBe(0);
    expect(seen).toEqual([25]);
    expect(sink.out.join("\n")).toMatch(/boot[\s\S]+ready/);
  });

  test("no subcommand prints usage and exits 2", async () => {
    const sink = capture();
    const res = await runDaemon([], { log: sink.log, error: sink.error });
    expect(res.exitCode).toBe(2);
    expect(sink.err.join("\n")).toMatch(/Usage: a2a-bridge daemon/);
  });

  test("unknown subcommand exits 1 with usage", async () => {
    const sink = capture();
    const res = await runDaemon(["wat"], { log: sink.log, error: sink.error });
    expect(res.exitCode).toBe(1);
    expect(sink.err.join("\n")).toMatch(/Usage: a2a-bridge daemon/);
  });

  test("targets reports not-running when the pid file is missing", async () => {
    const lc = new StubLifecycle({ pid: null });
    const sink = capture();
    let calls = 0;
    const res = await runDaemon(["targets"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
      queryTargets: async () => {
        calls += 1;
        return [];
      },
    });
    expect(res.exitCode).toBe(0);
    expect(calls).toBe(0);
    expect(sink.out.join("\n")).toMatch(/not running/);
  });

  test("targets queries the control plane and prints a table", async () => {
    const lc = new StubLifecycle({ pid: 9001 });
    const sink = capture();
    const now = 2_000_000;
    const res = await runDaemon(["targets"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
      queryTargets: async (url) => {
        expect(url).toBe("ws://127.0.0.1:4512/ws");
        const entries: TargetEntry[] = [
          { target: "claude:default", attached: true, clientId: 3, attachedAt: now - 42_000 },
          { target: "claude:alt", attached: true, clientId: 7, attachedAt: now - 5_000 },
        ];
        return entries;
      },
    });
    expect(res.exitCode).toBe(0);
    const joined = sink.out.join("\n");
    expect(joined).toMatch(/TARGET\s+ATTACHED\s+CLIENT\s+UPTIME/);
    expect(joined).toMatch(/claude:default\s+yes\s+3/);
    expect(joined).toMatch(/claude:alt\s+yes\s+7/);
  });

  test("targets surfaces query errors as exit 1", async () => {
    const lc = new StubLifecycle({ pid: 9001 });
    const sink = capture();
    const res = await runDaemon(["targets"], {
      buildLifecycle: () => lc,
      log: sink.log,
      error: sink.error,
      queryTargets: async () => {
        throw new Error("connection refused");
      },
    });
    expect(res.exitCode).toBe(1);
    expect(sink.err.join("\n")).toMatch(/daemon targets failed: connection refused/);
  });
});

describe("formatTargetsTable", () => {
  test("renders a fixed-width 4-column table", () => {
    const now = 10_000_000;
    const text = formatTargetsTable(
      [
        { target: "claude:default", attached: true, clientId: 3, attachedAt: now - 90_000 },
        { target: "codex:dev", attached: false },
      ],
      now,
    );
    const lines = text.split("\n");
    expect(lines[0]).toContain("TARGET");
    expect(lines[0]).toContain("ATTACHED");
    expect(lines[1]).toMatch(/claude:default\s+yes\s+3\s+1m/);
    expect(lines[2]).toMatch(/codex:dev\s+no\s+-\s+-/);
  });

  test("empty list prints a friendly message", () => {
    expect(formatTargetsTable([])).toBe("no targets registered");
  });
});
