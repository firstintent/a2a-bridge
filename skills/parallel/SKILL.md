---
name: parallel
description: Spawn N peer agents on genuinely independent subtasks, wait for every result, then merge. Use when subtasks do not read each other's outputs and the wall-clock saving is worth N× the token cost.
---

# parallel — spawn N independent peers, merge when they finish

The only safe multi-agent parallel pattern: carve the work into
subtasks that do not depend on each other's outputs, send each to a
peer, await all of them, then merge. If any subtask depends on
another's result, this pattern degrades to sequential with extra
steps and should not be used.

## When to use

- Subtasks are independent by construction — different files,
  different modules, different investigations, different doc pages.
- Each subtask's output is stable regardless of the others'
  outcomes.
- Wall-clock latency matters enough to justify N× the token cost.
  (The equivalent sequential run costs 1× tokens; parallel costs N×
  and only saves time.)

## When NOT to use

- Subtasks share context or build on each other's output. Merge
  loses fidelity; sequential with the real output is better.
- The "independence" is by job title (planner / implementer /
  tester / reviewer). This is sequential pretending to be parallel
  and almost always underperforms one session with the same tools.
- One of the subtasks would be cheap enough to inline. Parallel
  overhead only pays off when every branch is substantial.

## Protocol

Spawn one `message/stream` call per subtask. Each call gets its own
`contextId` so replies do not cross wires; a2a-bridge's `RoomRouter`
(Phase 4) isolates them end-to-end. Then await every SSE stream to
its terminal `status-update.final === true` and merge.

```
┌─ subtask A ─────────► peer 1 ─► artifact-update A ─► final A ┐
├─ subtask B ─────────► peer 2 ─► artifact-update B ─► final B ┤─► merge
└─ subtask C ─────────► peer 3 ─► artifact-update C ─► final C ┘
```

`return_format` per branch is a caller choice:

- `"full"` when each branch's raw output matters to the merge.
- `"summary"` when only a conclusion per branch matters (see
  `skills/context-protect/`).
- `"verdict"` when each branch is a check (see `skills/verify/`);
  merge is `pass` only when all branches return `pass`.

## Prompt scaffold

Each subtask gets a self-contained prompt. It must not reference the
other subtasks because the peer cannot see them.

```
You are handling subtask <k of N> in an independent parallel set.
Your output will be merged with the other subtasks' outputs; do NOT
reference or assume knowledge of them.

SCOPE:
<precisely what this subtask covers, e.g. "only files under
packages/auth/">

NON-SCOPE (explicitly ignore):
<what this subtask must not touch, so merges do not overlap>

TASK:
<concrete instruction>

OUTPUT FORMAT:
<same per-branch format — bullet list, JSON, verdict — so the merge
is a straightforward concatenation, not a transformation>
```

Keeping the output *format* identical across branches is the biggest
lever on merge quality; a heterogeneous output set forces a second
merge pass and usually erases the wall-clock win.

## Worked example

Scenario: review a cross-cutting PR that touches three independent
packages. A single reviewer session would have to hold all three
contexts. Three parallel review branches keep each context focused.

Call 1 (`packages/auth/`):

```json
{
  "jsonrpc": "2.0",
  "id": "par-auth",
  "method": "message/stream",
  "params": {
    "message": {
      "contextId": "ctx-auth-review",
      "parts": [{ "kind": "text", "text": "You are handling subtask 1 of 3 ... SCOPE: files under packages/auth/ in PR 4821. NON-SCOPE: everything else. TASK: flag any missing auth checks or input validation. OUTPUT FORMAT: JSON {\"findings\": [{\"file\": ..., \"line\": ..., \"issue\": ...}]}" }],
      "metadata": { "return_format": "full" }
    }
  }
}
```

Call 2 (`packages/billing/`) and Call 3 (`packages/notifications/`)
run in parallel with the same shape, different `contextId`s and
scopes.

Caller awaits all three SSE streams to completion, concatenates
`findings` arrays, and presents one merged list sorted by file.

## Merge checklist

- Every branch reached `final: true`? If not, retry the missing
  branch; do not pretend partial data covers the whole job.
- Output formats match? Heterogeneous formats mean the merge
  becomes its own LLM turn — add one more second to the wall-clock
  budget.
- Any branch returned `needs-info` (if you used the verdict
  variant)? Surface that branch's reasoning separately; do not
  silently drop it from the merge.

## See also

- [`architecture.md`](../../docs/design/architecture.md) §"return_format hint"
  — how each branch's output mode is relayed to the peer.
- `skills/verify/` — when each branch is a check and the merge is
  all-pass-or-fail.
- `skills/context-protect/` — when each branch should return a
  summary instead of raw output.
