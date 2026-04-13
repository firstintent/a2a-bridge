import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDirResolver } from "@shared/state-dir";
import { runInitConfig, type InitConfig } from "./init-config";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpStateDir(): StateDirResolver {
  const dir = mkdtempSync(join(tmpdir(), "a2a-bridge-init-cfg-"));
  dirs.push(dir);
  return new StateDirResolver(dir);
}

describe("runInitConfig", () => {
  test("first run writes a bearer token + config.json and prints snippets", () => {
    const stateDir = tmpStateDir();
    const lines: string[] = [];
    const result = runInitConfig({
      stateDir,
      log: (m) => lines.push(m),
      randomToken: () => "a".repeat(64),
      now: () => 1_700_000_000_000,
      port: 4520,
      host: "127.0.0.1",
    });

    expect(result.created).toBe(true);
    expect(result.config.bearerToken).toBe("a".repeat(64));
    expect(result.config.host).toBe("127.0.0.1");
    expect(result.config.port).toBe(4520);
    expect(result.config.createdAt).toBe(1_700_000_000_000);

    const path = join(stateDir.dir, "config.json");
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as InitConfig;
    expect(onDisk).toEqual(result.config);

    // Snippets mention each client target.
    const output = lines.join("\n");
    expect(output).toMatch(/Gemini CLI/);
    expect(output).toMatch(/OpenClaw/);
    expect(output).toMatch(/Zed/);
    expect(output).toContain("a".repeat(64));
  });

  test("re-running without --force reuses the stored token and does not rewrite", () => {
    const stateDir = tmpStateDir();
    const first = runInitConfig({
      stateDir,
      log: () => {},
      randomToken: () => "b".repeat(64),
      now: () => 1,
    });
    expect(first.created).toBe(true);

    const lines: string[] = [];
    const second = runInitConfig({
      stateDir,
      log: (m) => lines.push(m),
      // Different factory; a rewrite would pick this up. Idempotent
      // should ignore it.
      randomToken: () => "different-token",
      now: () => 99999,
    });
    expect(second.created).toBe(false);
    expect(second.config.bearerToken).toBe("b".repeat(64));
    expect(second.config.createdAt).toBe(1);
    expect(lines.some((l) => l.includes("Using existing config"))).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(join(stateDir.dir, "config.json"), "utf8"),
    ) as InitConfig;
    expect(onDisk.bearerToken).toBe("b".repeat(64));
  });

  test("--force overwrites with a fresh token even when config.json exists", () => {
    const stateDir = tmpStateDir();
    runInitConfig({
      stateDir,
      log: () => {},
      randomToken: () => "c".repeat(64),
      now: () => 1,
    });

    const forced = runInitConfig({
      stateDir,
      log: () => {},
      randomToken: () => "d".repeat(64),
      now: () => 2,
      force: true,
    });
    expect(forced.created).toBe(true);
    expect(forced.config.bearerToken).toBe("d".repeat(64));
    expect(forced.config.createdAt).toBe(2);

    const onDisk = JSON.parse(
      readFileSync(join(stateDir.dir, "config.json"), "utf8"),
    ) as InitConfig;
    expect(onDisk.bearerToken).toBe("d".repeat(64));
  });

  test("a malformed config.json is treated as absent and replaced", () => {
    const stateDir = tmpStateDir();
    const path = join(stateDir.dir, "config.json");
    stateDir.ensure();
    require("node:fs").writeFileSync(path, "not json");

    const result = runInitConfig({
      stateDir,
      log: () => {},
      randomToken: () => "e".repeat(64),
      now: () => 7,
    });
    expect(result.created).toBe(true);
    expect(result.config.bearerToken).toBe("e".repeat(64));
  });
});
