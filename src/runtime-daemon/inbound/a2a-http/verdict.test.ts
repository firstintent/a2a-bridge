import { describe, test, expect } from "bun:test";
import {
  parseVerdict,
  serializeVerdictArtifact,
  VERDICT_ARTIFACT_ID,
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

describe("serializeVerdictArtifact", () => {
  test("wraps a verdict in an A2A data-part artifact envelope", () => {
    const verdict: VerificationArtifact = {
      verdict: "pass",
      reasoning: "All checks pass.",
      evidence: [{ claim: "Tests pass", source: "src/foo.test.ts:42" }],
      followups: [],
    };
    const artifact = serializeVerdictArtifact(verdict);
    expect(artifact.artifactId).toBe(VERDICT_ARTIFACT_ID);
    expect(artifact.parts).toHaveLength(1);
    const part = artifact.parts[0];
    expect(part.kind).toBe("data");
    expect(part.mimeType).toBe("application/vnd.a2a-bridge.verdict+json");
    expect(part.data).toBe(verdict);
  });

  test("accepts a custom artifactId", () => {
    const verdict: VerificationArtifact = {
      verdict: "needs-info",
      reasoning: "Insufficient context.",
      evidence: [],
      followups: ["Attach CI logs"],
    };
    const artifact = serializeVerdictArtifact(verdict, { artifactId: "custom-verify-1" });
    expect(artifact.artifactId).toBe("custom-verify-1");
  });

  test("round-trips through parseVerdict without field loss", () => {
    const original: VerificationArtifact = {
      verdict: "fail",
      reasoning: "Missing null check on line 10.",
      evidence: [
        { claim: "Reproduces locally", source: "repro.sh", note: "crash trace attached" },
      ],
      followups: ["Add null guard", "Backfill regression test"],
    };
    const artifact = serializeVerdictArtifact(original);
    const extracted = artifact.parts[0].data;
    const result = parseVerdict(JSON.parse(JSON.stringify(extracted)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(original);
  });
});
