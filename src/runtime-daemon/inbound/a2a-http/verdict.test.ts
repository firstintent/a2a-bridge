import { describe, test, expect } from "bun:test";
import {
  parseVerdict,
  VERDICT_MIME_TYPE,
  type VerificationArtifact,
} from "@daemon/inbound/a2a-http/verdict";

describe("parseVerdict", () => {
  test("accepts a full happy-path artifact", () => {
    const payload = {
      verdict: "pass",
      reasoning: "Assertions match; no regressions detected.",
      evidence: [
        { claim: "Tests pass", source: "src/foo.test.ts:42" },
        { claim: "Lint clean", source: "eslint", note: "0 warnings" },
      ],
      followups: ["Consider adding a perf regression check"],
    };
    const result = parseVerdict(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const artifact: VerificationArtifact = result.value;
    expect(artifact.verdict).toBe("pass");
    expect(artifact.reasoning).toBe(payload.reasoning);
    expect(artifact.evidence).toEqual([
      { claim: "Tests pass", source: "src/foo.test.ts:42" },
      { claim: "Lint clean", source: "eslint", note: "0 warnings" },
    ]);
    expect(artifact.followups).toEqual(payload.followups);
  });

  test("defaults missing evidence and followups to empty arrays", () => {
    const result = parseVerdict({
      verdict: "fail",
      reasoning: "Assertion fails on line 10.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence).toEqual([]);
    expect(result.value.followups).toEqual([]);
  });

  test("coerces an unrecognized verdict to needs-info", () => {
    const result = parseVerdict({
      verdict: "maybe",
      reasoning: "Cannot conclusively determine correctness.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("needs-info");
  });

  test("coerces a missing verdict field to needs-info", () => {
    const result = parseVerdict({ reasoning: "No decision yet." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("needs-info");
  });

  test("rejects a payload missing reasoning", () => {
    const result = parseVerdict({ verdict: "pass" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/reasoning/);
  });

  test("rejects a payload with empty-string reasoning", () => {
    const result = parseVerdict({ verdict: "fail", reasoning: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/reasoning/);
  });

  test("rejects non-object inputs", () => {
    expect(parseVerdict("pass").ok).toBe(false);
    expect(parseVerdict(null).ok).toBe(false);
    expect(parseVerdict([]).ok).toBe(false);
  });

  test("rejects malformed evidence entries", () => {
    const result = parseVerdict({
      verdict: "fail",
      reasoning: "Problems detected.",
      evidence: [{ claim: "missing source" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/evidence\[0\]\.source/);
  });

  test("exports the stable mime type literal", () => {
    expect(VERDICT_MIME_TYPE).toBe("application/vnd.a2a-bridge.verdict+json");
  });
});
