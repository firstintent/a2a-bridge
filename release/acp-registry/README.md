# ACP registry submission

This directory contains the two files the public ACP registry at
[`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry)
expects for a new agent listing: `agent.json` and `icon.svg`. Copy
them into a fork of that repo and open a pull request to land
a2a-bridge in the registry alongside Claude, Gemini, and the other
editor-facing ACP agents.

## Files

| File | Purpose |
|------|---------|
| `agent.json` | Identifies the agent (id, display name, version, description, distribution). Conforms to the registry's [`agent.schema.json`](https://cdn.agentclientprotocol.com/registry/v1/latest/agent.schema.json). |
| `icon.svg` | 16×16 monochrome icon. All `fill` attributes use `currentColor` so the icon adopts the host UI's foreground color. |

## Distribution entry

The submission uses the **npx distribution** form:

```json
"distribution": {
  "npx": {
    "package": "@firstintent/a2a-bridge@0.1.0",
    "args": ["acp"]
  }
}
```

An editor that honors the registry resolves this into:

```
npx -y @firstintent/a2a-bridge@0.1.0 acp
```

which boots `a2a-bridge acp` — the ACP-over-stdio server the
`src/cli/cli.ts` dispatcher maps to `runAcp()`.

## Submission process

1. **Verify release is live on npm.** The `package` field pins
   `@firstintent/a2a-bridge@0.1.0`; the registry CI fetches that
   exact version to sanity-check the distribution. Do not submit
   before `npm publish` has completed.
2. **Fork** `agentclientprotocol/registry`.
3. **Copy these two files** into a directory named after the `id`
   field — i.e. `a2a-bridge/` at the repo root:
   ```
   a2a-bridge/
   ├── agent.json
   └── icon.svg
   ```
   The directory name MUST match `agent.json`'s `id`.
4. **Local validation** (optional but recommended):
   ```
   uv run --with jsonschema \
     .github/workflows/build_registry.py
   SKIP_URL_VALIDATION=1 uv run --with jsonschema \
     .github/workflows/build_registry.py
   ```
5. **Open the PR** against `main` with a short description:
   - What the agent does (one sentence).
   - Links to the project README and CHANGELOG.
   - A note confirming the agent responds to the ACP `initialize`
     handshake (tests in `src/cli/acp-inbound.test.ts`).

## Authentication caveat — read before submitting

The registry's verification workflow runs
`.github/workflows/verify_agents.py --auth-check` against every
agent and requires a non-empty `authMethods` array in the
`initialize` response (either `type: "agent"` for OAuth-style
self-managed auth or `type: "terminal"` for a `--setup`-style flow).

**a2a-bridge 0.1.0 does not yet advertise auth methods** —
the ACP server trusts Claude Code's own authentication and the
bearer token gating the A2A HTTPS endpoint. The registry CI will
therefore fail the auth check on this version.

Two options for the maintainer submitting the PR:

1. **Hold the submission** until a post-v0.1 release adds explicit
   ACP auth (tracked separately — the v0.1 roadmap intentionally
   scoped this out). Recommended if registry approval is
   time-sensitive.
2. **Open the PR anyway** and ask a registry maintainer to waive
   the auth-check step given that a2a-bridge delegates auth to the
   attached Claude Code session. Depending on the registry's
   policy this may or may not be accepted.

See
[`AUTHENTICATION.md`](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md)
for the full auth contract.

## Reference

- Format spec:
  [`FORMAT.md`](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md)
- Contribution guide:
  [`CONTRIBUTING.md`](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md)
- Schema:
  [`agent.schema.json`](https://github.com/agentclientprotocol/registry/blob/main/agent.schema.json)
- Example npm-distributed agent:
  [`claude-acp/agent.json`](https://github.com/agentclientprotocol/registry/blob/main/claude-acp/agent.json)
