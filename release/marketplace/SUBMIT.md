# Claude Code marketplace submission — a2a-bridge 0.1.0

This file is the maintainer-facing checklist for submitting
a2a-bridge to Anthropic's **official** Claude Code plugin
marketplace (the `claude-plugins-official` catalog exposed in the
Claude Code `/plugin` browser).

> **Important.** Third parties do **NOT** submit via a pull
> request to
> [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official).
> A GitHub Action on that repo
> (`.github/workflows/close-external-prs.yml`) auto-closes
> external PRs and points submitters at the official form.

## Submission URL

Submit through one of Anthropic's in-app forms — both require a
logged-in Anthropic account:

- **Claude.ai:** <https://claude.ai/settings/plugins/submit>
- **Platform Console:** <https://platform.claude.com/plugins/submit>

Short-link advertised by the auto-close bot:
<https://clau.de/plugin-directory-submission>.

The form accepts either a public GitHub repository URL or a zip
upload. a2a-bridge's canonical repo is
<https://github.com/firstintent/a2a-bridge> — submit that URL.

## Artifacts Anthropic requires

The form is behind auth, so the field labels are not publicly
documented. The items below cover every artifact an Anthropic
reviewer (or the `validate-marketplace.ts` check on the upstream
repo) will look at.

### 1. Plugin manifest

Located at
[`plugins/a2a-bridge/.claude-plugin/plugin.json`](../../plugins/a2a-bridge/.claude-plugin/plugin.json).

Required and recommended fields it already carries:

| Field         | Value |
|---------------|-------|
| `name`        | `a2a-bridge` |
| `version`     | `0.1.0` |
| `description` | Bridge Claude Code with other AI coding agents (Codex, OpenClaw, Hermes, ...) through a shared daemon, push channel delivery, and bidirectional reply tooling. |
| `author`      | `{ "name": "FirstIntent" }` |
| `homepage`    | <https://github.com/firstintent/a2a-bridge#readme> |
| `repository`  | <https://github.com/firstintent/a2a-bridge> |
| `license`     | `MIT` |

### 2. Marketplace entry

Located at
[`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json).
Fully populated in P6.6: 300+ char description, 13 `keywords`,
four `tags`, `category: "development"`, `homepage`, `repository`,
`author.url`, `license`, and three `screenshots` placeholder
paths under `docs/screenshots/`.

### 3. Screenshots

The marketplace entry references three placeholder paths:

```
docs/screenshots/gemini-cli-handshake.png
docs/screenshots/zed-acp-session.png
docs/screenshots/daemon-status.png
```

**Status:** TODO — the PNG files are not yet in the repo.
Capture them before submission:

1. **`gemini-cli-handshake.png`** — terminal screenshot showing
   `gemini` CLI routing `@a2a-bridge` to Claude Code, with the
   A2A agent-card URL visible in the session header.
2. **`zed-acp-session.png`** — Zed editor with a2a-bridge
   registered under `agent_servers`, mid-prompt, showing an
   `agent_message_chunk` reply.
3. **`daemon-status.png`** — `a2a-bridge daemon status` output
   showing the pid, control port, and health/control URLs.

Anthropic has **not published** icon/screenshot size, aspect
ratio, or format requirements. The in-app submission form will
surface whatever it needs at the moment of submission — be
prepared to crop/resize on the fly. PNG at 1600×900 or similar
(standard blog-hero aspect ratio) is a safe default.

### 4. Marketplace-level icon

**Not currently required** — the upstream
`claude-plugins-official` repo ships no icons for any of its
~220 listings. If the form asks, the 16×16 currentColor icon
under [`release/acp-registry/icon.svg`](../acp-registry/icon.svg)
can be reused.

### 5. README

The repo root [`README.md`](../../README.md) is
organized around Install → Configure → Connect (Gemini CLI /
OpenClaw / Zed / VS Code) → Troubleshooting, with a CI status
badge in the header. No length limit is documented; current
length is ~260 lines, well within typical marketplace norms.

## Pre-flight validation

Run these three commands from the repo root before opening the
form. Every step should exit 0:

```bash
claude plugin validate plugins/a2a-bridge
claude plugin validate .claude-plugin/marketplace.json
bun scripts/check-plugin-versions.js
```

`claude plugin validate` is the same check the upstream
marketplace runs in CI — if it passes locally, the internal
reviewer's `validate-marketplace.ts` pass will also pass.

## Submission checklist

Run down this list the day of submission:

- [ ] `bun run check:ci` green on `dev`
- [ ] 0.1.0 tag pushed and `release.yml` workflow published the
      npm tarball (`npm view @firstintent/a2a-bridge@0.1.0`
      returns metadata)
- [ ] `claude plugin validate plugins/a2a-bridge` exits 0
- [ ] `claude plugin validate .claude-plugin/marketplace.json`
      exits 0
- [ ] `docs/screenshots/gemini-cli-handshake.png` committed
- [ ] `docs/screenshots/zed-acp-session.png` committed
- [ ] `docs/screenshots/daemon-status.png` committed
- [ ] `CHANGELOG.md`'s `## [0.1.0]` header updated from
      `— Unreleased` to the release date
- [ ] Open <https://claude.ai/settings/plugins/submit> (or the
      Console equivalent), paste the GitHub URL, and fill in
      whatever the form asks for
- [ ] After submission, forward the confirmation email to the
      release tracker

## What NOT to do

- Do not open a PR against `anthropics/claude-plugins-official`
  — it will be auto-closed inside a minute.
- Do not pick a plugin `name` from the marketplace's reserved
  list (`claude-code-marketplace`, `claude-code-plugins`,
  `claude-plugins-official`, `anthropic-marketplace`,
  `anthropic-plugins`, `agent-skills`,
  `knowledge-work-plugins`, `life-sciences`). `a2a-bridge` is
  not on the list.
- Do not submit before the npm 0.1.0 release is live — the form
  may probe the `source` to validate; a missing tarball is a
  fast rejection.

## Reference

- Anthropic docs: <https://code.claude.com/docs/en/plugins>
- Marketplaces reference:
  <https://code.claude.com/docs/en/plugin-marketplaces>
- Plugin manifest reference:
  <https://code.claude.com/docs/en/plugins-reference>
- Upstream catalog (read-only, don't PR):
  <https://github.com/anthropics/claude-plugins-official>
- `validate-marketplace.ts` source for internal gate:
  <https://github.com/anthropics/claude-plugins-official/blob/main/.github/scripts/validate-marketplace.ts>
