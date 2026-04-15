/**
 * P10.1 unit tests for TargetId parser / formatter.
 */
import { describe, test, expect } from "bun:test";
import {
  parseTarget,
  formatTarget,
  assertTarget,
  DEFAULT_INSTANCE_ID,
} from "@shared/target-id";

describe("parseTarget — happy path", () => {
  test("kind:id splits cleanly", () => {
    const r = parseTarget("claude:project-a");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parts).toEqual({ kind: "claude", id: "project-a" });
      expect(r.target as string).toBe("claude:project-a");
    }
  });

  test("bare kind defaults id to 'default'", () => {
    const r = parseTarget("claude");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parts).toEqual({ kind: "claude", id: DEFAULT_INSTANCE_ID });
      expect(r.target as string).toBe("claude:default");
    }
  });

  test("underscore and digits allowed in both segments", () => {
    const r = parseTarget("codex_v2:instance_01");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parts).toEqual({ kind: "codex_v2", id: "instance_01" });
    }
  });

  test("hyphen allowed in id", () => {
    const r = parseTarget("claude:my-project-2");
    expect(r.ok).toBe(true);
  });
});

describe("parseTarget — rejection cases", () => {
  test("empty string rejected", () => {
    const r = parseTarget("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-empty");
  });

  test("only colon rejected", () => {
    const r = parseTarget(":");
    expect(r.ok).toBe(false);
  });

  test("leading colon rejected", () => {
    const r = parseTarget(":foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("empty kind");
  });

  test("trailing colon rejected", () => {
    const r = parseTarget("foo:");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("empty id");
  });

  test("multiple colons rejected", () => {
    const r = parseTarget("a:b:c");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("multiple");
  });

  test("uppercase rejected in kind", () => {
    const r = parseTarget("Claude:foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kind");
  });

  test("uppercase rejected in id", () => {
    const r = parseTarget("claude:Foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("id");
  });

  test("space rejected", () => {
    const r = parseTarget("claude:foo bar");
    expect(r.ok).toBe(false);
  });

  test("dot rejected", () => {
    const r = parseTarget("claude:foo.bar");
    expect(r.ok).toBe(false);
  });

  test("slash rejected", () => {
    const r = parseTarget("claude:foo/bar");
    expect(r.ok).toBe(false);
  });
});

describe("formatTarget", () => {
  test("round-trips via parseTarget", () => {
    const formatted = formatTarget({ kind: "claude", id: "project-a" });
    expect(formatted as string).toBe("claude:project-a");
    const r = parseTarget(formatted);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parts).toEqual({ kind: "claude", id: "project-a" });
  });

  test("throws on invalid parts", () => {
    expect(() => formatTarget({ kind: "Claude", id: "foo" })).toThrow();
    expect(() => formatTarget({ kind: "claude", id: "" })).toThrow();
    expect(() => formatTarget({ kind: "", id: "foo" })).toThrow();
  });
});

describe("assertTarget", () => {
  test("returns branded TargetId for valid input", () => {
    const t = assertTarget("codex:main");
    expect(t as string).toBe("codex:main");
  });

  test("throws on invalid input", () => {
    expect(() => assertTarget("bad string")).toThrow();
    expect(() => assertTarget("")).toThrow();
    expect(() => assertTarget(":bad")).toThrow();
  });
});
