# Verified cross-bridge join transcripts

One Markdown file per successful manual verification of
[`docs/join.md`](../../join.md) against live Claude Code + live ACP
client sessions.  Filenames use ISO-8601 dates: `2026-04-14.md`,
`2026-04-14-b.md`, etc.  Each transcript is evidence that a real
cross-bridge join worked end-to-end for a given commit, which is
what we point at when someone asks "does this actually work?"

This directory is never auto-populated.  Do not fabricate entries —
the whole point is human verification on real infrastructure.

## What a transcript should record

1. **Environment** — commit SHA, host OS, Claude Code version,
   ACP-client version (OpenClaw / Zed / VS Code), tarball URL used.
2. **CC-side install log** — the output of `a2a-bridge init` and
   `a2a-bridge daemon start` (redact the bearer token).
3. **ACP-side install log** — the output of `a2a-bridge --version`
   and the config snippet you added to your ACP client.
4. **Smoke prompt + reply** — the exact prompt sent through the
   ACP client and the full reply text received back.  Assert the
   reply does NOT begin with `Echo:` and is not a stock template —
   it should read like something Claude Code would actually say.
5. **Anything broken** — note any fixes you had to make the skill
   work.  Those notes feed back into `docs/join.md` updates.

## Template

```markdown
# Cross-bridge join verification — YYYY-MM-DD

- **Commit:** `<sha>`
- **Host OS:** macOS 15.4 / Ubuntu 24.04 / …
- **Claude Code:** <version>
- **ACP client:** OpenClaw <version> / Zed <version> / VS Code ACP <version>
- **Tarball URL:** https://github.com/firstintent/a2a-bridge/releases/download/v0.1.0/a2a-bridge-0.1.0.tgz

## CC side

```
$ a2a-bridge init
…

$ a2a-bridge daemon start
…
```

## ACP client side

```
$ a2a-bridge --version
a2a-bridge v0.1.0
```

Added to <config file path>:

```
…
```

## Smoke prompt

> <exact text sent through the ACP client>

### Reply received

> <exact reply text — not an echo, not a refusal>

## Notes

- <anything that needed a workaround>
```

The maintainer signs off on the release by committing a new
transcript alongside the version bump in P9.5.
