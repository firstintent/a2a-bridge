# a2a-bridge documentation

Everything a reader needs beyond the repo root README lives here.
Contents are grouped by purpose:

## Design

Read these to understand what a2a-bridge is, why it exists, and how
the code is organized.

- [`design/architecture.md`](./design/architecture.md) — runtime
  layout, dependency rules, A2A + ACP inbound surfaces, deployment
  shapes.
- [`design/positioning.md`](./design/positioning.md) — the design
  principles that decide what a2a-bridge will and won't do.
- [`design/roadmap.md`](./design/roadmap.md) — shipped v0.1 scope
  and the v0.2 backlog.

## Guides

Practical walk-throughs for contributors and users.

- [`guides/cookbook.md`](./guides/cookbook.md) — verification,
  context-protection, and parallel-work patterns, with `curl` and
  SDK examples plus a rough token-cost table.
- [`guides/rooms.md`](./guides/rooms.md) — RoomId derivation,
  multi-session isolation guarantees, TaskLog persistence, per-Room
  adapter lifecycle.
- [`guides/contributing.md`](./guides/contributing.md) — how to
  set up a development clone, the validation chain, PR expectations.

## Release

Maintainer-facing runbooks for cutting a release.

- [`release/publish.md`](./release/publish.md) — the 11-step
  day-of-release flow (bump check → CHANGELOG finalize → tag →
  release.yml → `npm publish --otp` → marketplace form → ACP
  registry PR → post-release smoke).

## See also

- Repo root [`README.md`](../README.md) — install, configure,
  connect editors.
- Repo root [`CHANGELOG.md`](../CHANGELOG.md) — user-facing changes
  per version.
- Repo root [`CLAUDE.md`](../CLAUDE.md) — operational rules for
  autonomous Claude Code sessions running against this repo.
- Skill templates at [`../skills/`](../skills) —
  copy-paste prompt scaffolds for the patterns the cookbook
  documents.
- Release submission packages at [`../release/`](../release) —
  `release/acp-registry/` (fork + PR target) and
  `release/marketplace/SUBMIT.md` (form submission checklist).
