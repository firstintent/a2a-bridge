/**
 * P10.2 unit tests — workspace id derivation.
 */
import { describe, test, expect } from "bun:test";
import {
  resolveWorkspaceId,
  resolveClaudeTarget,
} from "@shared/workspace-id";

describe("resolveWorkspaceId — priority chain", () => {
  test("env A2A_BRIDGE_WORKSPACE_ID wins over everything", () => {
    const id = resolveWorkspaceId({
      env: {
        A2A_BRIDGE_WORKSPACE_ID: "explicit",
        A2A_BRIDGE_STATE_DIR: "/some/path/should-not-be-used",
      },
      stateDirPath: "/another/path/also-ignored",
      conversationId: "abcdef1234567890",
    });
    expect(id).toBe("explicit");
  });

  test("falls back to A2A_BRIDGE_STATE_DIR basename", () => {
    const id = resolveWorkspaceId({
      env: { A2A_BRIDGE_STATE_DIR: "/home/user/.config/a2a-bridge/project-a" },
      conversationId: "abcdef1234567890",
    });
    expect(id).toBe("project-a");
  });

  test("falls back to stateDirPath when env unset", () => {
    const id = resolveWorkspaceId({
      env: {},
      stateDirPath: "/tmp/workspace-x",
    });
    expect(id).toBe("workspace-x");
  });

  test("falls back to conversationId prefix", () => {
    const id = resolveWorkspaceId({
      env: {},
      conversationId: "abcd1234ef567890",
    });
    expect(id).toBe("abcd1234");
  });

  test("falls back to 'default' when nothing else", () => {
    const id = resolveWorkspaceId({ env: {} });
    expect(id).toBe("default");
  });
});

describe("resolveWorkspaceId — sanitisation", () => {
  test("uppercase normalised to lowercase", () => {
    const id = resolveWorkspaceId({
      env: { A2A_BRIDGE_WORKSPACE_ID: "Project-A" },
    });
    expect(id).toBe("project-a");
  });

  test("spaces and dots replaced with hyphens", () => {
    const id = resolveWorkspaceId({
      env: { A2A_BRIDGE_WORKSPACE_ID: "my project.v2" },
    });
    expect(id).toBe("my-project-v2");
  });

  test("repeated hyphens collapsed", () => {
    const id = resolveWorkspaceId({
      env: { A2A_BRIDGE_WORKSPACE_ID: "a---b__c" },
    });
    expect(id).toBe("a-b__c");
  });

  test("leading/trailing hyphens stripped", () => {
    const id = resolveWorkspaceId({
      env: { A2A_BRIDGE_WORKSPACE_ID: "-foo-" },
    });
    expect(id).toBe("foo");
  });

  test("all-disallowed override falls through to next source", () => {
    const id = resolveWorkspaceId({
      env: { A2A_BRIDGE_WORKSPACE_ID: "!!!", A2A_BRIDGE_STATE_DIR: "/x/clean-name" },
    });
    expect(id).toBe("clean-name");
  });
});

describe("resolveClaudeTarget", () => {
  test("returns a valid claude:<id> TargetId", () => {
    const t = resolveClaudeTarget({
      env: { A2A_BRIDGE_WORKSPACE_ID: "team-alpha" },
    });
    expect(t as string).toBe("claude:team-alpha");
  });

  test("default when nothing supplied", () => {
    const t = resolveClaudeTarget({ env: {} });
    expect(t as string).toBe("claude:default");
  });
});
