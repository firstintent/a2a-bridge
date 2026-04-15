/**
 * P10.6 — `a2a-bridge claude --force` flag extraction.
 *
 * The `--force` flag is ours, not CC's. We strip it from the raw
 * argv before calling `claude`, and forward operator intent to the
 * plugin via `A2A_BRIDGE_FORCE_ATTACH`. This test locks the parser
 * so future refactors can't silently break either half.
 */
import { describe, test, expect } from "bun:test";
import { extractForceFlag } from "./claude";

describe("extractForceFlag", () => {
  test("strips --force and sets force=true", () => {
    const res = extractForceFlag(["--force", "--verbose"]);
    expect(res.force).toBe(true);
    expect(res.forwarded).toEqual(["--verbose"]);
  });

  test("absent --force leaves argv untouched and force=false", () => {
    const res = extractForceFlag(["--continue", "foo"]);
    expect(res.force).toBe(false);
    expect(res.forwarded).toEqual(["--continue", "foo"]);
  });

  test("preserves argument order around the stripped flag", () => {
    const res = extractForceFlag(["-a", "--force", "-b", "c"]);
    expect(res.force).toBe(true);
    expect(res.forwarded).toEqual(["-a", "-b", "c"]);
  });

  test("does not match partial flags like --forceful", () => {
    const res = extractForceFlag(["--forceful"]);
    expect(res.force).toBe(false);
    expect(res.forwarded).toEqual(["--forceful"]);
  });
});
