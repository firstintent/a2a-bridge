/**
 * Verification artifact schema (see ARCHITECTURE.md §"Verification artifact").
 *
 * Shape carried inside an A2A `Artifact.parts[]` entry with
 * `kind: "data"` and `mimeType: "application/vnd.a2a-bridge.verdict+json"`.
 * The serializer that wraps a parsed artifact into the A2A envelope lives
 * alongside this module (P3.3); this file owns the schema + parser only.
 */

export const VERDICT_MIME_TYPE = "application/vnd.a2a-bridge.verdict+json";
export const VERDICT_ARTIFACT_ID = "verification-verdict";

export type VerificationVerdict = "pass" | "fail" | "needs-info";

export interface VerificationEvidence {
  claim: string;
  source: string;
  note?: string;
}

export interface VerificationArtifact {
  verdict: VerificationVerdict;
  reasoning: string;
  evidence: VerificationEvidence[];
  followups: string[];
}

export type ParseVerdictResult =
  | { ok: true; value: VerificationArtifact }
  | { ok: false; error: string };

/**
 * A2A artifact envelope carrying a verification verdict. Matches the
 * shape `handleMessageStream` already emits for `artifact-update` events
 * (`{ artifactId, parts: [...] }`), with a `data` part whose `mimeType`
 * is the stable `VERDICT_MIME_TYPE`.
 */
export interface VerdictArtifactEnvelope {
  artifactId: string;
  parts: [
    {
      kind: "data";
      mimeType: typeof VERDICT_MIME_TYPE;
      data: VerificationArtifact;
    },
  ];
}

/**
 * Wrap a parsed `VerificationArtifact` in its A2A data-part envelope.
 * Paired with `parseVerdict` as the round-trip: the value produced by
 * this function, when extracted back out via `parts[0].data`, parses
 * successfully and preserves every field.
 */
export function serializeVerdictArtifact(
  verdict: VerificationArtifact,
  options: { artifactId?: string } = {},
): VerdictArtifactEnvelope {
  return {
    artifactId: options.artifactId ?? VERDICT_ARTIFACT_ID,
    parts: [
      {
        kind: "data",
        mimeType: VERDICT_MIME_TYPE,
        data: verdict,
      },
    ],
  };
}

const KNOWN_VERDICTS: readonly VerificationVerdict[] = ["pass", "fail", "needs-info"];

/**
 * Validate an unknown payload against the verification artifact shape.
 *
 * Unrecognized `verdict` values are coerced to `"needs-info"`, matching the
 * spec's "unrecognized values are treated as needs-info" rule. Missing or
 * empty `reasoning` is rejected — verifiers that cannot articulate reasoning
 * should return a `"needs-info"` verdict with a short note instead.
 */
export function parseVerdict(value: unknown): ParseVerdictResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "expected an object" };
  }

  const raw = value as Record<string, unknown>;

  if (typeof raw.reasoning !== "string" || raw.reasoning.trim().length === 0) {
    return { ok: false, error: "reasoning must be a non-empty string" };
  }

  const verdict: VerificationVerdict =
    typeof raw.verdict === "string" &&
    (KNOWN_VERDICTS as readonly string[]).includes(raw.verdict)
      ? (raw.verdict as VerificationVerdict)
      : "needs-info";

  const evidenceResult = parseEvidenceList(raw.evidence);
  if (!evidenceResult.ok) return evidenceResult;

  const followupsResult = parseFollowups(raw.followups);
  if (!followupsResult.ok) return followupsResult;

  return {
    ok: true,
    value: {
      verdict,
      reasoning: raw.reasoning,
      evidence: evidenceResult.value,
      followups: followupsResult.value,
    },
  };
}

function parseEvidenceList(
  raw: unknown,
):
  | { ok: true; value: VerificationEvidence[] }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "evidence must be an array" };

  const out: VerificationEvidence[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `evidence[${i}] must be an object` };
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.claim !== "string" || entry.claim.length === 0) {
      return { ok: false, error: `evidence[${i}].claim must be a non-empty string` };
    }
    if (typeof entry.source !== "string" || entry.source.length === 0) {
      return { ok: false, error: `evidence[${i}].source must be a non-empty string` };
    }
    const parsed: VerificationEvidence = { claim: entry.claim, source: entry.source };
    if (entry.note !== undefined) {
      if (typeof entry.note !== "string") {
        return { ok: false, error: `evidence[${i}].note must be a string when present` };
      }
      parsed.note = entry.note;
    }
    out.push(parsed);
  }
  return { ok: true, value: out };
}

function parseFollowups(
  raw: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "followups must be an array" };
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== "string") {
      return { ok: false, error: `followups[${i}] must be a string` };
    }
  }
  return { ok: true, value: raw as string[] };
}
