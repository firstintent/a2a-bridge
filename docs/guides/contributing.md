# Contributing

Thanks for contributing to a2a-bridge.

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+
- [Codex CLI](https://github.com/openai/codex) (only needed for the
  Codex peer adapter tests; other development paths work without it)

## Setup

```bash
bun install
bun link    # makes the `a2a-bridge` command available globally
```

### Local development

Use the `dev` command to register a local plugin marketplace and sync
plugin files to the Claude Code cache:

```bash
a2a-bridge dev     # register local marketplace + sync plugin
a2a-bridge claude  # start Claude Code with the plugin auto-loaded
```

After changing plugin or runtime code, run `a2a-bridge dev` again and
either restart Claude Code or invoke `/reload-plugins` in an active
session.

## Development workflow

1. Create a focused branch for one change (`feat/xxx`, `fix/xxx`,
   `docs/xxx`).
2. Make the smallest coherent change that solves the problem.
3. Update documentation when behavior, setup, or limitations change.
4. Run validation locally before opening a pull request.
5. All PRs target `dev`; `main` is updated by release PRs only.

## Validation

`bun run check:ci` is the single command every PR must pass before
it can merge. It chains:

```
tsc --noEmit                              # type check
bun run lint:deps                         # dependency-cruiser rules
bun run test:unit                         # unit tests (E2E filtered)
bun run build:plugin                      # plugin bundle builds
bun scripts/check-plugin-versions.js      # manifest version alignment
bash scripts/smoke-tarball.sh             # npm pack + install probe
bash scripts/smoke-e2e.sh                 # A2A + ACP wire smoke
```

CI runs the same chain on every PR, matrix on Ubuntu + macOS
(`.github/workflows/ci.yml`). If your change affects the user-visible
bridge flow, add manual reproduction steps in the PR description.

## Testing

- **Unit tests** — co-located with source files (`*.test.ts`).
- **E2E tests** — filtered out of the default `test:unit` run via the
  `E2E:` test-name prefix; the smoke scripts cover the same ground
  under `check:ci`. Files live alongside the units, not in a
  separate directory.
- **Integration tests** — `src/cli/concurrent-sessions.test.ts` (two
  A2A clients), `src/cli/plugin-reconnect-survival.test.ts`
  (task-survival across reconnect).

## Pull requests

- Keep PRs small and scoped to one problem.
- Never push directly to `main` — always use feature/fix branches +
  PR into `dev`, then release PRs from `dev` into `main`.
- Explain the user-visible change and the reason for it.
- Include the `bun run check:ci` output in the PR description.
- Link related issues when applicable.

## Code style

- TypeScript with strict typing.
- Prefer small, explicit functions over broad refactors.
- Preserve the current architecture unless the PR is intentionally
  structural.
- Avoid committing local machine config, secrets, logs, or generated
  noise.
- Keep comments short and only where they add real context.
- Use `execFileSync` (array form) instead of `execSync` (string
  form) to avoid shell injection.
- When crossing directory boundaries, prefer tsconfig path aliases
  (`@shared/*`, `@messages/*`, `@transport/*`, `@plugin/*`,
  `@daemon/*`) over relative `../` chains.

## Reading next

- [`architecture.md`](../design/architecture.md) — runtime layout,
  dependency rules enforced by `bun run lint:deps`, and the A2A /
  ACP inbound surfaces.
- [`positioning.md`](../design/positioning.md) — the design
  principles; read this before proposing a refactor.
- [`roadmap.md`](../design/roadmap.md) — shipped phases and the v0.2
  backlog.
- [`CLAUDE.md`](../../CLAUDE.md) — operational rules for autonomous
  Claude Code sessions running against this repo.
