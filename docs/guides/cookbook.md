# a2a-bridge pattern cookbook

End-to-end examples for the three patterns a2a-bridge is designed to
make ergonomic:

1. **Verification** — delegate a check, receive a structured verdict.
2. **Context protection** — push a long dig to a peer, take back a
   summary.
3. **Parallel independent work** — spawn N peers on independent
   subtasks, merge.

Every example is copy-pasteable as a `curl` call and as an
`@a2a-js/sdk` snippet. Each pattern is paired with a
[skill template](../../skills) that teaches the prompting scaffold.

## Prerequisites

- Daemon running with A2A inbound enabled and a bearer token. The
  default host+port is `http://localhost:4520`.
- Environment variables used below:
  - `BRIDGE_URL=http://localhost:4520`
  - `BRIDGE_TOKEN=<A2A_BRIDGE_BEARER_TOKEN>` (same value the daemon
    was started with)
- SDK snippets assume `@a2a-js/sdk` is installed in the caller
  project (`bun add @a2a-js/sdk` or `npm i @a2a-js/sdk`).
- All `curl` calls target the JSON-RPC endpoint at
  `$BRIDGE_URL/a2a`. The `.well-known/agent-card.json` endpoint
  lives at `$BRIDGE_URL/.well-known/agent-card.json` and is used by
  the SDK for discovery; if `publicAgentCard: true` it does not
  require the bearer.

## Rough token-cost reference

Multi-agent patterns cost more than a single-session equivalent.
The numbers below are order-of-magnitude for a ~2k-token artifact
with ~1k-token criteria/input; real costs vary with prompt size,
reasoning style, and whether the peer runs tool calls.

| Pattern                | Peer turns | Rough overhead vs. single-session equivalent |
|------------------------|------------|----------------------------------------------|
| Verification           | 1 (check)  | 2–3× total tokens (original + verdict)       |
| Context protection     | 1 (dig)    | ~1× total; saves the caller ~N×input tokens  |
| Parallel (N branches)  | N          | N× tokens, ~1× wall-clock vs. sequential      |

The daemon attaches `metadata.tokenUsage` to each terminal
`status-update` when the executor supplies it (see P3.8); callers
can log or display this to make the overhead visible up front.

---

## 1. Verification

**Skill template:** [`skills/verify/SKILL.md`](../../skills/verify/SKILL.md).

**When to use:** you have an artifact and explicit criteria, you
want pass/fail + reasoning, and you do NOT want the peer to rewrite.

**Wire shape:** `message/stream` with
`Message.metadata.return_format = "verdict"`. The peer replies with
a single `artifact-update` whose `parts[0]` is a `data` part with
mime `application/vnd.a2a-bridge.verdict+json`, followed by a
terminal `status-update(completed, final: true)`.

### curl

```bash
curl -sN -X POST "$BRIDGE_URL/a2a" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  --data @- <<'JSON'
{
  "jsonrpc": "2.0",
  "id": "verify-1",
  "method": "message/stream",
  "params": {
    "message": {
      "kind": "message",
      "messageId": "msg-1",
      "role": "user",
      "parts": [
        { "kind": "text", "text": "You are a verifier. Do not rewrite. ARTIFACT: <paste middleware source + unit test>. CRITERIA: 1) returns 429 over limit, 2) window resets on tick, 3) excludes /health. Return a JSON verdict." }
      ],
      "metadata": { "return_format": "verdict" }
    }
  }
}
JSON
```

### SDK

```ts
import { A2AClient } from "@a2a-js/sdk";

const authedFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${process.env.BRIDGE_TOKEN}`);
  return fetch(input, { ...init, headers });
};

const client = await A2AClient.fromCardUrl(
  `${process.env.BRIDGE_URL}/.well-known/agent-card.json`,
  { fetchImpl: authedFetch },
);

const stream = client.sendMessageStream({
  message: {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: "You are a verifier. Do not rewrite. ARTIFACT: <...>. CRITERIA: ..." }],
    metadata: { return_format: "verdict" },
  },
});

for await (const event of stream) {
  if (event.kind === "artifact-update") {
    const part = event.artifact.parts[0];
    if (part?.kind === "data" && part.mimeType === "application/vnd.a2a-bridge.verdict+json") {
      const verdict = part.data as { verdict: "pass" | "fail" | "needs-info"; reasoning: string };
      console.log("verdict:", verdict.verdict, verdict.reasoning);
    }
  }
}
```

**Rough cost:** 2–3× a single-session equivalent (the original turn
that produced the artifact + the verifier turn). Verifier prompts
stay small because they quote criteria, not implementation.

---

## 2. Context protection

**Skill template:** [`skills/context-protect/SKILL.md`](../../skills/context-protect/SKILL.md).

**When to use:** the subtask's raw output would crowd the primary
session (long logs, transcripts, audits); you only need a
conclusion.

**Wire shape:** `message/stream` with
`Message.metadata.return_format = "summary"`. The peer adapter
surfaces the hint to the peer; the peer compresses its own output
before returning. The response is ordinary `artifact-update` / text
parts — the bridge does not rewrite on your behalf.

### curl

```bash
curl -sN -X POST "$BRIDGE_URL/a2a" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  --data @- <<'JSON'
{
  "jsonrpc": "2.0",
  "id": "ctx-1",
  "method": "message/stream",
  "params": {
    "message": {
      "kind": "message",
      "messageId": "msg-2",
      "role": "user",
      "parts": [
        { "kind": "text", "text": "QUESTION: which test ids failed with 'deadline exceeded' 14:00–15:00? INPUT: <inline CI log>. OUTPUT FORMAT: bullet list, at most 8 bullets 'TEST_ID — upstream (timestamp)', end with a one-sentence bottom line." }
      ],
      "metadata": { "return_format": "summary" }
    }
  }
}
JSON
```

### SDK

```ts
const stream = client.sendMessageStream({
  message: {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: "QUESTION: ... INPUT: <log> OUTPUT FORMAT: bullet list ..." }],
    metadata: { return_format: "summary" },
  },
});

let summary = "";
for await (const event of stream) {
  if (event.kind === "artifact-update") {
    for (const part of event.artifact.parts) {
      if (part.kind === "text") summary += part.text;
    }
  } else if (event.kind === "status-update" && event.final) {
    console.log("summary:\n" + summary);
    const usage = (event.metadata as { tokenUsage?: { totalTokens: number } } | undefined)?.tokenUsage;
    if (usage) console.log(`(peer used ${usage.totalTokens} tokens so the caller didn't have to)`);
  }
}
```

**Rough cost:** roughly 1× the tokens of the peer's dig; your
primary session saves the raw input (~N× input tokens you never
paste). The net is a win whenever the peer's input is much larger
than the peer's summary.

---

## 3. Parallel independent work

**Skill template:** [`skills/parallel/SKILL.md`](../../skills/parallel/SKILL.md).

**When to use:** subtasks are independent by construction (different
modules, files, or investigations). Do not use when one subtask
depends on another's output.

**Wire shape:** N concurrent `message/stream` calls, each with its
own `contextId` so a2a-bridge's RoomRouter (Phase 4) isolates
branches end-to-end. Await every SSE stream to its terminal
`status-update(final: true)`, then merge.

### curl

Spawn three independent reviews in parallel; merge the JSON
outputs once they finish.

```bash
# Three backgrounded curls, one per subtask. Each uses a distinct
# contextId so the daemon routes them to separate Rooms.
for pkg in auth billing notifications; do
  (curl -sN -X POST "$BRIDGE_URL/a2a" \
    -H "Authorization: Bearer $BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$(cat <<JSON
{
  "jsonrpc": "2.0",
  "id": "par-$pkg",
  "method": "message/stream",
  "params": {
    "message": {
      "contextId": "ctx-review-$pkg",
      "kind": "message",
      "messageId": "msg-$pkg",
      "role": "user",
      "parts": [
        { "kind": "text", "text": "You are subtask <$pkg> of 3. SCOPE: packages/$pkg/. NON-SCOPE: everything else. TASK: flag missing auth checks or input validation. OUTPUT FORMAT: {\"findings\": [{\"file\": ..., \"line\": ..., \"issue\": ...}]}" }
      ],
      "metadata": { "return_format": "full" }
    }
  }
}
JSON
    )" \
    > "review-$pkg.ndjson") &
done
wait
```

Then `jq` the three NDJSON streams, pull out the final text parts,
and concatenate the `findings` arrays.

### SDK

```ts
async function runBranch(scope: string): Promise<unknown[]> {
  const stream = client.sendMessageStream({
    message: {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "user",
      contextId: `ctx-review-${scope}`,
      parts: [
        {
          kind: "text",
          text: `You are subtask ${scope}. SCOPE: packages/${scope}/. NON-SCOPE: everything else. TASK: flag missing auth checks or input validation. OUTPUT FORMAT: {"findings": [...]}.`,
        },
      ],
      metadata: { return_format: "full" },
    },
  });

  let buffer = "";
  for await (const event of stream) {
    if (event.kind === "artifact-update") {
      for (const part of event.artifact.parts) {
        if (part.kind === "text") buffer += part.text;
      }
    }
  }
  const parsed = JSON.parse(buffer) as { findings: unknown[] };
  return parsed.findings;
}

const merged = (
  await Promise.all(["auth", "billing", "notifications"].map(runBranch))
).flat();
console.log(`${merged.length} merged findings`);
```

**Rough cost:** N× tokens versus a single-session equivalent (each
branch pays its own prompt + reasoning). The win is wall-clock: N
branches run concurrently, so the observed latency is the slowest
single branch, not the sum.

---

## See also

- [`architecture.md`](../design/architecture.md) §"Verification
  artifact", §"return_format hint" — authoritative contract for the
  fields every example uses.
- [`positioning.md`](../design/positioning.md) — when multi-agent
  patterns are worth the overhead and when they are not.
- The three skill templates under
  [`skills/`](../../skills) — copy-paste prompt scaffolds.
