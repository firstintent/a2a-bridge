# Join the a2a-bridge

> **Read me and follow the steps for your host.**  The same document
> covers both sides of the bridge — when a user hands this URL to
> Claude Code **and** to OpenClaw (or Zed, or the VS Code ACP
> extension), each AI self-installs its side and the two can talk.

This skill installs the a2a-bridge v0.1.0 tarball on whichever
machine you (the host AI) are running on, wires up the matching
config, and verifies the round-trip works end-to-end.

---

## Step 0 — Identify yourself

Before doing anything else, tell the user which host you are:

- If you are **Claude Code** (the CLI, desktop app, or IDE extension
  from Anthropic), say so and jump to [**Claude Code side**](#claude-code-side).
- If you are **OpenClaw** (or Zed, VS Code ACP extension, or any
  other ACP-speaking editor that launches agents via `acpx` /
  `agent_servers` / similar), say so and jump to
  [**ACP client side**](#acp-client-side).
- If neither — stop and ask the user which side they want you to
  install.  Do not guess.

Only one side runs per host.  The user is expected to run this skill
twice — once on the Claude Code machine, once on the ACP-client
machine.  If both machines are the same box, the order is: Claude
Code side first (so the daemon is live), then ACP client side.

---

## Claude Code side

On this side you install the tarball, generate a bearer token, and
start the daemon.  You then report the control port and (optionally)
the bearer token to the user so they can paste it on the ACP side.

### 1. Install

```bash
npm i -g https://github.com/firstintent/a2a-bridge/releases/download/v0.1.0/firstintent-a2a-bridge-0.1.0.tgz
```

Verify the install:

```bash
a2a-bridge --version
```

Expected output: `a2a-bridge v0.1.0`.  If the command is not found,
check that your npm global bin directory (`npm config get prefix`)
is on `PATH`.

### 2. First-time configure

```bash
a2a-bridge init
```

This is idempotent — re-running prints the existing config instead
of overwriting it.  The output includes:

- A freshly-minted 32-byte hex bearer token.
- Copy-paste config snippets for Gemini CLI, OpenClaw, and Zed.
- The state-dir path (default: `~/.config/a2a-bridge/`).

### 3. Start the daemon

```bash
a2a-bridge daemon start
```

Then check it is healthy:

```bash
a2a-bridge daemon status
```

Expected output names the pid, control port (default `4512`), and
A2A inbound port (default `4520`).  If `start` reports a port
collision, set `A2A_BRIDGE_A2A_PORT=<free port>` in your environment
and re-run `init --force` to regenerate the config snippets.

### 4. Report back to the user

Tell the user, verbatim, so they can hand it to the ACP side:

```
Claude Code side ready.
  control port: <port from `daemon status`>
  bearer token: <token from `init`>
```

The control port is what `a2a-bridge acp` will connect to.  The
bearer token is only needed for A2A HTTP callers (Gemini CLI etc.);
ACP clients connecting via stdio inherit filesystem trust and do
not need it.

### 5. Leave the daemon running

Do **not** kill the daemon after this skill finishes — the ACP side
needs a live daemon to route turns into your Claude Code session.
`a2a-bridge daemon stop` cleanly terminates it whenever the user is
done.

---

## ACP client side

On this side you install the tarball, register `a2a-bridge acp` as
an ACP agent in the client's config, and drive a one-shot prompt
through to verify the real CC path works.

### 1. Install

```bash
npm i -g https://github.com/firstintent/a2a-bridge/releases/download/v0.1.0/firstintent-a2a-bridge-0.1.0.tgz
```

Verify:

```bash
a2a-bridge --version
```

Expected output: `a2a-bridge v0.1.0`.

### 2. Register the ACP agent

The config file depends on which client you are:

- **OpenClaw (`acpx`)** — `~/.config/acpx/acpx.yaml` (or the path
  your `acpx --help` reports).  Add under `agents:`:

  ```yaml
  agents:
    a2a-bridge:
      command: a2a-bridge
      args: ["acp"]
  ```

- **Zed** — `~/.config/zed/settings.json`.  Add under
  `agent_servers`:

  ```json
  {
    "agent_servers": {
      "a2a-bridge": {
        "command": "a2a-bridge",
        "args": ["acp"]
      }
    }
  }
  ```

- **VS Code ACP extension** — settings JSON path depends on the
  extension.  Use:

  ```json
  {
    "acp.agents": [
      {
        "name": "a2a-bridge",
        "command": "a2a-bridge",
        "args": ["acp"]
      }
    ]
  }
  ```

If the config file already has other agents, keep them; append
`a2a-bridge` alongside.

### 3. Restart the ACP client

Most ACP clients re-read their agent config at startup.  Restart
the client (or run the client's "Reload agents" action if it has
one).  Confirm that `a2a-bridge` appears in the agent picker.

### 4. Smoke-test the bridge

Send a one-shot prompt through the a2a-bridge agent — exact shape
depends on the client, but the pattern is the same everywhere:

> "Say the word `pineapple` and nothing else."

Then assert:

- You receive a reply.
- The reply text does **not** start with `Echo:` or contain
  `a2a-bridge ACP inbound: no ClaudeCodeGateway configured`.  Either
  indicates the subprocess has no live daemon to talk to.
- The reply reads like something Claude Code would actually say
  (not a canned template).

If the reply is wrong or you get an `error: / fix:` block:

- `error: a2a-bridge acp cannot reach the daemon at …` —
  the Claude Code side did not finish step 3.  Ask the user to
  run `a2a-bridge daemon status` on the CC side.
- `ECONNREFUSED` or similar — the daemon was started but the ACP
  side is pointed at the wrong control port.  Check that the user
  did not override `A2A_BRIDGE_CONTROL_PORT` on either side.

### 5. Report back to the user

Once the smoke prompt returns a real reply, tell the user:

```
ACP client side ready.
  agent name: a2a-bridge
  first prompt reply: "<short summary of what Claude Code said>"
```

The user can now drive real prompts through the ACP client normally;
a2a-bridge transparently relays them.

---

## Troubleshooting

- **The install command fails with a 404.**  The v0.1.0 draft
  release may still be pending publication.  Ask the user to
  confirm the release is **published** (not just drafted) at
  <https://github.com/firstintent/a2a-bridge/releases/tag/v0.1.0>;
  draft assets are not reachable without authentication.

- **`a2a-bridge doctor` reports `FAIL` on a required check.**  Run
  `a2a-bridge doctor` on whichever side is failing and follow the
  `fix:` hints — every required-check failure names the exact
  command or environment variable to set.

- **The smoke prompt times out.**  Check `a2a-bridge daemon logs`
  on the Claude Code side for the most recent turn.  The daemon
  log records each `acp_turn_start` / `chunk` / `complete`; if the
  log shows `startTurn` but no reply, the attached Claude Code
  session is the stuck party.

- **Config already exists on first-run.**  `a2a-bridge init` never
  overwrites an existing token unless you pass `--force`.  Tell the
  user: the previous token is fine to reuse, and they can print it
  again with `a2a-bridge init --print`.

---

## What this skill does not do

- It does **not** configure the A2A HTTP inbound (Gemini CLI
  `remoteAgents`) — `init` prints the snippet, but adding it to
  the Gemini CLI config is the user's call.
- It does **not** set up TLS or multi-machine daemons.  The v0.1
  bridge assumes the CC daemon and the ACP client are on the same
  host (unix socket / localhost WS).  Cross-host deployment lands
  in v0.2.
- It does **not** run `npm publish` or submit the Claude Code
  marketplace / ACP registry packages — those are credentialed
  maintainer steps.

For the full design — why this is built as two halves instead of a
single end-to-end protocol — see
[`docs/design/architecture.md`](./design/architecture.md) and
[`docs/design/positioning.md`](./design/positioning.md).
