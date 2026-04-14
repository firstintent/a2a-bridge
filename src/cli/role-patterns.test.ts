import { describe, expect, test } from "bun:test";
import { ClaudeAdapter, CLAUDE_INSTRUCTIONS } from "@plugin/claude-channel/claude-adapter";
import { BRIDGE_CONTRACT_REMINDER } from "@daemon/message-filter";

describe("role-aware collaboration guidance", () => {
  test("claude instructions include agent-agnostic interaction guidance", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("a2a-bridge connects you to other AI agents");
    expect(CLAUDE_INSTRUCTIONS).toContain("reply tool");
    expect(CLAUDE_INSTRUCTIONS).toContain("get_messages");
  });

  test("claude instructions include turn coordination guidance", () => {
    expect(CLAUDE_INSTRUCTIONS).toContain("is working");
    expect(CLAUDE_INSTRUCTIONS).toContain("busy error");
  });

  test("bridge contract reminder includes codex role guidance", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Your default role: Implementer, Executor, Verifier");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Independent Analysis & Convergence");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Architect -> Builder -> Critic");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Hypothesis -> Experiment -> Interpretation");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Do not blindly follow Claude");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("My independent view is:");
  });

  test("bridge contract reminder specifies marker must be at start", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("at the very start");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("MUST be the first text");
  });

  test("bridge contract reminder forbids git write operations", () => {
    expect(BRIDGE_CONTRACT_REMINDER).toContain("Git Operations — FORBIDDEN");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("MUST NOT execute any git write commands");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("hang indefinitely");
    expect(BRIDGE_CONTRACT_REMINDER).toContain("delegated to Claude Code");
  });

  test("CLAUDE_INSTRUCTIONS is wired into MCP Server", () => {
    const adapter = new ClaudeAdapter() as any;
    const serverInstructions = adapter.server._instructions;
    expect(serverInstructions).toBe(CLAUDE_INSTRUCTIONS);
  });
});
