import { describe, test, expect } from "bun:test";
import { runDoctor, type DoctorDeps } from "./doctor";

function makeDeps(overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  const allGood: DoctorDeps = {
    bunVersion: () => "1.3.7",
    a2aPortFree: async () => true,
    acpSdkPath: () => "/n/m/@agentclientprotocol/sdk",
    ccPluginPath: () => "/plugins/a2a-bridge",
    stateDirWritable: () => true,
    initRan: () => true,
  };
  return { ...allGood, ...overrides };
}

describe("runDoctor", () => {
  test("all checks pass → exit 0, every line reports pass", async () => {
    const lines: string[] = [];
    const { results, exitCode } = await runDoctor({
      deps: makeDeps(),
      log: (m) => lines.push(m),
    });
    expect(exitCode).toBe(0);
    expect(results.every((r) => r.status === "pass")).toBe(true);
    expect(lines.join("\n")).toMatch(/All required checks passed/);
  });

  test("missing bun produces a required fail → exit 1", async () => {
    const { results, exitCode } = await runDoctor({
      deps: makeDeps({ bunVersion: () => null }),
      log: () => {},
    });
    expect(exitCode).toBe(1);
    const bun = results.find((r) => r.name === "bun runtime");
    expect(bun?.status).toBe("fail");
  });

  test("bun older than 1.3 is a fail", async () => {
    const { results, exitCode } = await runDoctor({
      deps: makeDeps({ bunVersion: () => "1.2.9" }),
      log: () => {},
    });
    expect(exitCode).toBe(1);
    expect(results.find((r) => r.name === "bun runtime")?.status).toBe("fail");
  });

  test("missing ACP SDK is a required fail", async () => {
    const { results, exitCode } = await runDoctor({
      deps: makeDeps({ acpSdkPath: () => null }),
      log: () => {},
    });
    expect(exitCode).toBe(1);
    expect(results.find((r) => r.name === "ACP SDK")?.status).toBe("fail");
  });

  test("busy A2A port is a warn (not a fail)", async () => {
    const { results, exitCode } = await runDoctor({
      deps: makeDeps({ a2aPortFree: async () => false }),
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(results.find((r) => r.name === "A2A port")?.status).toBe("warn");
  });

  test("missing CC plugin is a warn (not a fail)", async () => {
    const { results, exitCode } = await runDoctor({
      deps: makeDeps({ ccPluginPath: () => null }),
      log: () => {},
    });
    expect(exitCode).toBe(0);
    const plugin = results.find((r) => r.name === "CC channel plugin");
    expect(plugin?.status).toBe("warn");
  });

  test("state-dir not writable is a required fail", async () => {
    const { results, exitCode } = await runDoctor({
      deps: makeDeps({ stateDirWritable: () => false }),
      log: () => {},
    });
    expect(exitCode).toBe(1);
    expect(results.find((r) => r.name === "state-dir writable")?.status).toBe("fail");
  });

  test("init not yet run is a warn (not a fail)", async () => {
    const { results, exitCode } = await runDoctor({
      deps: makeDeps({ initRan: () => false }),
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(results.find((r) => r.name === "init already run")?.status).toBe("warn");
  });

  test("a single fail is enough to exit 1 even when others pass", async () => {
    const { exitCode } = await runDoctor({
      deps: makeDeps({ acpSdkPath: () => null }),
      log: () => {},
    });
    expect(exitCode).toBe(1);
  });
});
