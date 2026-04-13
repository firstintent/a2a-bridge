---
name: context-protect
description: Delegate a long-tail investigation (log dig, audit, transcript analysis) to a peer agent and take back only a summary. Use when the raw output would crowd out 1000+ tokens of the primary session that do not need to live there.
---

# context-protect — delegate a long dig, keep the summary

Your primary session's context is the scarcest resource it has. When
a subtask would otherwise dump a long log, a codebase audit, or a
full transcript analysis into it, push the work to a peer and keep
only the summary. The peer stays free to grind through the full
data; your session stays free to reason about the conclusion.

## When to use

- The input is long (log file, directory listing, CI trace,
  transcript).
- You only need a conclusion, a bug location, a count, or a bullet
  list — not the raw material.
- The primary session does not need to answer follow-up questions
  about *other* details buried in the input. If it might, fetch the
  full output instead; summarization is lossy.

## When NOT to use

- You cannot enumerate the question up front. Summarization works
  when you know what you want to learn; it fails when you are still
  orienting.
- The peer's summary is not trustworthy without spot-checks. Either
  verify the summary via a second pass (see `skills/verify/`) or
  pull the raw data.
- The task is cheap to run inline. Paying for a second agent's
  context just to avoid a 200-token paste is not worth it.

## Protocol

Set `Message.metadata.return_format` to `"summary"` on the
`message/stream` request:

```json
{
  "message": {
    "parts": [{ "kind": "text", "text": "<digest prompt>" }],
    "metadata": { "return_format": "summary" }
  }
}
```

The peer adapter surfaces `return_format: "summary"` to the peer
(the bridge does not summarize on its own — adapters relay the hint
to the model). The peer is expected to compress its own output
before returning; the shape that comes back is ordinary text, not a
structured artifact.

## Prompt scaffold

```
You are assisting a larger session that is TIGHT ON CONTEXT. Answer
the QUESTION below using the INPUT, then return ONLY the summary
requested — no raw excerpts longer than a single line of evidence
per bullet, no preambles, no "here is the summary" framing.

QUESTION:
<one specific question, e.g. "Which request ids failed with a
timeout between 14:00 and 15:00, and which upstream did they point
at?">

INPUT:
<paste or attach the log / audit / transcript>

OUTPUT FORMAT:
- Bullet list, at most N bullets.
- Each bullet: one fact, one citation (timestamp / line / file:line).
- End with a single-sentence "bottom line" summarizing the pattern.
```

## Worked example

Scenario: Claude Code is debugging a flaky integration test and
suspects a race. A 2,400-line CI log holds the clue. Pasting it into
the primary session would consume ~18k tokens. Instead, delegate.

Request:

```json
{
  "jsonrpc": "2.0",
  "id": "ctx-1",
  "method": "message/stream",
  "params": {
    "message": {
      "parts": [
        {
          "kind": "text",
          "text": "QUESTION: Between 14:00 and 15:00, which test ids failed with a 'deadline exceeded' error, and what upstream service did each point at?\n\nINPUT:\n<full CI log inlined here>\n\nOUTPUT FORMAT: bullet list, at most 8 bullets, each 'TEST_ID — upstream (timestamp)'. End with a single-sentence bottom line."
        }
      ],
      "metadata": { "return_format": "summary" }
    }
  }
}
```

Terminal reply the caller reads from the final `status-update.message`:

```
- t_c3k9 — payments-svc (14:03:17Z)
- t_91xa — payments-svc (14:11:02Z)
- t_8pzb — auth-svc (14:18:40Z)
- t_7qm1 — payments-svc (14:23:55Z)
- t_ffa0 — payments-svc (14:39:12Z)
- t_kr42 — payments-svc (14:51:09Z)

Bottom line: every failure except t_8pzb points at payments-svc;
timing clusters around 10–15 minute gaps, consistent with a per-pool
connection-timeout refresh rather than a request-level race.
```

Claude Code carries the six-line summary into its next prompt
instead of the 2,400-line log. The primary session stays lean; the
peer absorbs the full cost of the dig.

## See also

- [`architecture.md`](../../docs/design/architecture.md) §"return_format hint"
  — authoritative wording on how adapters relay the hint.
- `skills/verify/` — pairs well with this pattern when the summary
  itself needs a spot-check.
