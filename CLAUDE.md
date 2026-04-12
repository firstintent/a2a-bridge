# CLAUDE.md — cc-bridge

## Project

**cc-bridge** is a bidirectional bridge between Claude Code and other AI coding agents (Codex, OpenClaw, Hermes, ...) built on the Claude Code Channels protocol. Modelled after `raysonmeng/agent-bridge` but designed from day one for:

- Pluggable peer adapters (one adapter per target agent)
- Multi-machine deployment (daemon on one host, CC on another)
- Multi-room / concurrent CC sessions

## Language policy — **strict**

Everything stored in this git repo MUST be in English:

- Source code, including variable names and string literals
- **All code comments**
- **Commit messages** (subject and body)
- Pull request titles and descriptions
- Issue titles and bodies
- File and directory names
- README, ARCHITECTURE, ROADMAP, and any other top-level docs

Chinese-language documentation lives in `docs/`, which is **git-ignored** (see `.gitignore`). `docs/` is a scratchpad for local design notes, meeting memos, and translation drafts — it must never be committed.

Rationale: this is an open-source project targeting a global audience. Mixed-language repos fragment the reader base and confuse grep.

## Stack

- TypeScript, Bun runtime (matches upstream `agent-bridge`)
- MIT license
- Two-process topology: foreground MCP plugin + persistent daemon
- Peer adapters implement a common `IPeerAdapter` interface

## Git workflow

- All changes land on `dev`, never directly on `main`
- `git push origin dev`, then open a PR to merge into `main`
- Never force-push `main`
- Never commit secrets (tokens, private keys, `.env` files)

## References (read-only)

Upstream repos cloned under the parent workspace's `references/` directory:

- `references/agent-bridge` — the CC↔Codex prototype we are generalizing
- `references/cc-plugins-official` — Anthropic's official channel plugin examples (telegram, fakechat are the best references)
- `references/openclaw` — OpenClaw source (peer adapter target)
- `references/hermes-agent` — Hermes ACP source (peer adapter target)
