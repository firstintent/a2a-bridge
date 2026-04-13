import { describe, test, expect } from "bun:test";
import {
  formatBindInUse,
  formatMissingAcpSdk,
  formatMissingBearerToken,
  formatMissingCcPlugin,
  renderFriendlyError,
} from "./errors";

describe("formatBindInUse", () => {
  test("cause mentions the port and the in-use state", () => {
    const e = formatBindInUse(4520);
    expect(e.cause).toMatch(/port 4520/i);
    expect(e.cause).toMatch(/in use/i);
  });

  test("fix names the port env var and a retry path", () => {
    const e = formatBindInUse(4520);
    expect(e.fix).toMatch(/A2A_BRIDGE_A2A_PORT/);
    expect(e.fix).toMatch(/stop|free/i);
  });

  test("different ports produce different cause lines", () => {
    expect(formatBindInUse(9999).cause).toMatch(/9999/);
  });
});

describe("formatMissingBearerToken", () => {
  test("cause flags the missing token and auth impact", () => {
    const e = formatMissingBearerToken();
    expect(e.cause).toMatch(/bearer token/i);
    expect(e.cause).toMatch(/authenticat/i);
  });

  test("fix points at `a2a-bridge init` and the env var", () => {
    const e = formatMissingBearerToken();
    expect(e.fix).toMatch(/a2a-bridge init/);
    expect(e.fix).toMatch(/A2A_BRIDGE_BEARER_TOKEN/);
  });
});

describe("formatMissingCcPlugin", () => {
  test("cause flags the missing plugin and CC reachability", () => {
    const e = formatMissingCcPlugin();
    expect(e.cause).toMatch(/plugin/i);
    expect(e.cause).toMatch(/Claude Code/);
  });

  test("fix names the init/dev subcommands", () => {
    const e = formatMissingCcPlugin();
    expect(e.fix).toMatch(/a2a-bridge init/);
    expect(e.fix).toMatch(/a2a-bridge dev/);
  });
});

describe("formatMissingAcpSdk", () => {
  test("cause names the @agentclientprotocol/sdk package", () => {
    const e = formatMissingAcpSdk();
    expect(e.cause).toMatch(/@agentclientprotocol\/sdk/);
  });

  test("fix recommends `bun install`", () => {
    const e = formatMissingAcpSdk();
    expect(e.fix).toMatch(/bun install/);
  });
});

describe("renderFriendlyError", () => {
  test("emits exactly two lines: cause first, fix second", () => {
    const block = renderFriendlyError({
      cause: "Something broke.",
      fix: "Try again.",
    });
    const lines = block.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("error: Something broke.");
    expect(lines[1]).toBe("  fix: Try again.");
  });

  test("renders each built-in helper into a two-line block", () => {
    for (const err of [
      formatBindInUse(4520),
      formatMissingBearerToken(),
      formatMissingCcPlugin(),
      formatMissingAcpSdk(),
    ]) {
      const block = renderFriendlyError(err);
      expect(block.split("\n")).toHaveLength(2);
      expect(block.startsWith("error: ")).toBe(true);
      expect(block).toMatch(/\n  fix: /);
    }
  });
});
