---
name: verify
description: Delegate a verification check to a peer agent and consume a structured pass/fail/needs-info verdict instead of free-form text. Use when you want a second agent to check work against explicit criteria without rewriting it.
---

# verify — delegate a verification check

Ask a peer agent to evaluate an artifact (code, a plan, a doc, a
diff) against explicit criteria and return a structured verdict.
This is the Anthropic-validated pattern that's consistently worth
the extra tokens: a second agent either confirms the work or flags
a specific problem — it does not rewrite.

## When to use

- You produced something and want an independent pass/fail, not a
  revision.
- The criteria are enumerable ("does X, handles edge case Y, passes
  test Z").
- You want the verifier's disagreement surfaced as evidence, not
  silently merged back into your own output.

## When NOT to use

- You want the peer to *do* the work. That's delegation, not
  verification — prompt a peer directly without this pattern.
- The criteria are vague ("is this good?"). Verifiers cannot return
  useful structured verdicts without concrete checks.
- The cost of the second call is not justified. Verification
  typically 2–3× the tokens of the original turn.

## Protocol

On the A2A inbound surface, set `Message.metadata.return_format` to
`"verdict"` when sending `message/stream`:

```json
{
  "message": {
    "parts": [{ "kind": "text", "text": "<verifier prompt>" }],
    "metadata": { "return_format": "verdict" }
  }
}
```

The peer responds with an A2A `artifact-update` whose part has
`kind: "data"` and `mimeType: "application/vnd.a2a-bridge.verdict+json"`.
The `data` object matches the verification artifact shape from
`docs/design/architecture.md` §"Verification artifact":

```json
{
  "verdict": "pass" | "fail" | "needs-info",
  "reasoning": "one to three sentences",
  "evidence": [
    { "claim": "string", "source": "file:line | url | inline", "note": "optional" }
  ],
  "followups": ["string", ...]
}
```

Unrecognized verdict values are coerced to `"needs-info"`. An empty
or missing `reasoning` is rejected — verifiers that cannot articulate
reasoning must return `"needs-info"` with a short note instead.

## Prompt scaffold

Send the verifier a prompt with three explicit sections. Keep
criteria enumerated; vague criteria produce vague verdicts.

```
You are a verifier. Do not rewrite, do not extend, do not offer
suggestions unless asked. Your job is to decide whether the ARTIFACT
satisfies every CRITERION below, cite the specific evidence you
relied on, and return a verdict.

ARTIFACT:
<paste the code / plan / diff / doc here, inline or as a code block>

CRITERIA (return "pass" iff all hold, otherwise "fail"; use
"needs-info" only when a criterion cannot be evaluated with the
ARTIFACT as given):
1. <criterion>
2. <criterion>
3. <criterion>

RETURN a single JSON object with shape:
{
  "verdict": "pass" | "fail" | "needs-info",
  "reasoning": "1–3 sentences tying the verdict to the criteria",
  "evidence": [{ "claim": "...", "source": "file:line or inline" }],
  "followups": ["optional next actions for the caller"]
}
```

## Worked example

Caller (Claude Code) wants a peer to verify that a new rate-limit
middleware actually enforces the intended limit.

Request:

```json
{
  "jsonrpc": "2.0",
  "id": "verify-1",
  "method": "message/stream",
  "params": {
    "message": {
      "parts": [
        {
          "kind": "text",
          "text": "You are a verifier. ...\nARTIFACT:\n<middleware source + unit test>\nCRITERIA:\n1. Returns 429 after exceeding N requests/window.\n2. Window resets correctly on clock tick.\n3. Excludes the health-check path.\nRETURN a JSON verdict object."
        }
      ],
      "metadata": { "return_format": "verdict" }
    }
  }
}
```

Streamed artifact frame the caller sees back (pretty-printed):

```json
{
  "kind": "artifact-update",
  "artifact": {
    "artifactId": "verification-verdict",
    "parts": [
      {
        "kind": "data",
        "mimeType": "application/vnd.a2a-bridge.verdict+json",
        "data": {
          "verdict": "fail",
          "reasoning": "Criterion 3 fails — the middleware rate-limits /health alongside everything else, which will trip the liveness probe under load.",
          "evidence": [
            { "claim": "/health is included in the rate-limit map", "source": "src/middleware/rate-limit.ts:42" },
            { "claim": "No bypass path array in the config", "source": "src/middleware/rate-limit.ts:15" }
          ],
          "followups": [
            "Add an `excludePaths: string[]` option and list /health in the default",
            "Extend the unit test to assert /health is never 429"
          ]
        }
      }
    ]
  }
}
```

Caller uses the structured verdict to drive its next action: on
`pass` the turn completes; on `fail` the `followups` list becomes
the caller's next prompt to its primary agent; on `needs-info` the
caller surfaces the missing context before retrying.

## See also

- [`architecture.md`](../../docs/design/architecture.md) §"Verification artifact"
  — the authoritative schema.
- `src/runtime-daemon/inbound/a2a-http/verdict.ts` —
  `parseVerdict` / `serializeVerdictArtifact` implementations.
