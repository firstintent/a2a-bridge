# Join the a2a-bridge

> **Read me and follow the steps for your host.** The same document
> covers both sides of the bridge — when a user hands this URL to
> Claude Code **and** to OpenClaw (or Zed, or the VS Code ACP
> extension), each AI self-installs its side and the two can talk.

This skill installs the current `a2a-bridge` npm package on whichever
machine you (the host AI) are running on, wires up the matching
config, and verifies the round-trip works end-to-end.

---

## Step 0 — Identify yourself

Before doing anything else, tell the user which host you are:

- If you are **Claude Code** (the CLI, desktop app, or IDE extension
  from Anthropic), say so and jump to
  [**Claude Code side**](#claude-code-side).
- If you are **OpenClaw** (or Zed, VS Code ACP extension, or any
  other ACP-speaking editor that launches agents via `acpx` /
  `agent_servers` / similar), say so and jump to
  [**ACP client side**](#acp-client-side).
- If neither — stop and ask the user which side they want you to
  install. Do not guess.

Only one side runs per host. The user is expected to run this skill
twice — once on the Claude Code machine, once on the ACP-client
machine. If both machines are the same box, the order is: Claude
Code side first (so the daemon is live), then ACP client side.

---

## Claude Code side

On this side you install the tarball, generate a bearer token, and
start the daemon. You then report the control port and (optionally)
the bearer token to the user so they can paste it on the ACP side.

### 1. Install

```bash
npm install -g a2a-bridge@latest
```

Verify:

```bash
a2a-bridge --version         # prints `a2a-bridge v<current>`
```

If the command is not found, check that your npm global bin
directory (`npm config get prefix`) is on `PATH`.

### 2. First-time configure

```bash
a2a-bridge init
```

Idempotent — re-running prints the existing config instead of
overwriting it. Output includes:

- A freshly-minted 32-byte hex bearer token.
- Copy-paste config snippets for Gemini CLI, OpenClaw, and Zed.
- The state-dir path (default: `~/.local/state/a2a-bridge/`).

Pass `--force` to rotate the bearer token if you need to.

### 3. Start the daemon

```bash
a2a-bridge daemon start
```

Then check:

```bash
a2a-bridge daemon status
```

Expected output names the pid, control port (default `4512`), and
A2A inbound port (default `4520`).

**Remote deployment?** If the ACP client is on a *different* machine,
bind the control plane to all interfaces before starting:

```bash
export A2A_BRIDGE_CONTROL_HOST=0.0.0.0
export A2A_BRIDGE_A2A_HOST=0.0.0.0
a2a-bridge daemon start
```

On the ACP side, clients connect with `--url ws://<server-ip>:4512/ws`
(see ACP client side below). Put a TLS proxy in front if the link
leaves your trust boundary — the daemon terminates plaintext WS.

If `start` reports a port collision, set
`A2A_BRIDGE_A2A_PORT=<free port>` in your environment and re-run
`init --force` to regenerate the config snippets.

### 4. (Optional) Launch Claude Code with the bridge plugin

```bash
a2a-bridge claude
```

Starts Claude Code with the a2a-bridge plugin auto-loaded. Keep the
window open for as long as you want to be reachable. If the daemon
isn't running yet, `a2a-bridge claude` bootstraps it.

### 5. Report back to the user

Tell the user, verbatim, so they can hand it to the ACP side:

```
Claude Code side ready.
  server ip:    <machine IP the ACP side can reach>
  control port: <port from `daemon status`, default 4512>
  bearer token: <token from `init`>
```

The control port is what `a2a-bridge acp` will connect to. The
bearer token is only needed for A2A HTTP callers (Gemini CLI etc.);
ACP clients connecting via stdio or WS inherit filesystem / network
trust and don't need it.

### 6. Leave the daemon running

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
npm install -g a2a-bridge@latest
a2a-bridge --version
```

### 2. Register the ACP agent

The config depends on which client you are and whether the Claude
Code daemon is on the **same machine** or a **remote server**.

#### Same machine (daemon on localhost)

- **OpenClaw** — edit `openclaw.json` (two places):

  1. Add `a2a-bridge` to `acp.allowedAgents`:
     ```json
     "acp": {
       "allowedAgents": ["claude", "codex", "a2a-bridge"]
     }
     ```

  2. Register the command under `plugins.entries.acpx.config.agents`:
     ```json
     "plugins": {
       "entries": {
         "acpx": {
           "enabled": true,
           "config": {
             "agents": {
               "a2a-bridge": {
                 "command": "a2a-bridge",
                 "args": ["acp"]
               }
             }
           }
         }
       }
     }
     ```

  Restart OpenClaw, then `/acp spawn a2a-bridge`.

- **Zed** — `~/.config/zed/settings.json`:

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

#### Remote server (daemon on a different machine at `<SERVER_IP>`)

- **OpenClaw** — same two places, with an explicit `command` path
  and `--url` in `args`:

  ```json
  "acp": {
    "allowedAgents": ["claude", "codex", "a2a-bridge"]
  },
  "plugins": {
    "entries": {
      "acpx": {
        "config": {
          "agents": {
            "a2a-bridge": {
              "command": "a2a-bridge",
              "args": [
                "acp",
                "--url", "ws://<SERVER_IP>:4512/ws"
              ]
            }
          }
        }
      }
    }
  }
  ```

  > Some acpx builds don't inherit the shell `PATH` when they spawn.
  > If `/acp spawn a2a-bridge` fails with a vague
  > `ACP_SESSION_INIT_FAILED`, replace `"command": "a2a-bridge"`
  > with the absolute path from `which a2a-bridge`.

  Replace `<SERVER_IP>` with the Claude Code machine's IP from the
  CC side's step 5. Then `/acp spawn a2a-bridge`.

- **Zed** — supports an `env` field:

  ```json
  {
    "agent_servers": {
      "a2a-bridge": {
        "command": "a2a-bridge",
        "args": ["acp"],
        "env": {
          "A2A_BRIDGE_CONTROL_URL": "ws://<SERVER_IP>:4512/ws"
        }
      }
    }
  }
  ```

- **VS Code ACP extension** — settings JSON path depends on the
  extension. Use:

  ```json
  {
    "acp.agents": [
      {
        "name": "a2a-bridge",
        "command": "a2a-bridge",
        "args": ["acp", "--url", "ws://<SERVER_IP>:4512/ws"]
      }
    ]
  }
  ```

If the config file already has other agents, keep them; append
`a2a-bridge` alongside.

### 3. Restart the ACP client

Most ACP clients re-read their agent config at startup. Restart the
client (or run the client's "Reload agents" action if it has one).
Confirm that `a2a-bridge` appears in the agent picker.

### 4. Smoke-test the bridge

Send a one-shot prompt through the a2a-bridge agent — exact shape
depends on the client, but the pattern is the same everywhere:

> "Say the word `pineapple` and nothing else."

Then assert:

- You receive a reply.
- The reply text does **not** start with `Echo:` or contain
  `a2a-bridge ACP inbound: no ClaudeCodeGateway configured`.
  Either indicates the subprocess has no live daemon to talk to.
- The reply reads like something Claude Code would actually say
  (not a canned template).

### 5. Report back to the user

Once the smoke prompt returns a real reply, tell the user:

```
ACP client side ready.
  agent name: a2a-bridge
  first prompt reply: "<short summary of what Claude Code said>"
```

The user can now drive real prompts through the ACP client; the
bridge transparently relays them.

---

## Advanced — multiple Claude Code workspaces (v0.2)

One daemon can front **multiple** Claude Code sessions simultaneously.
Each session attaches under a `kind:id` **TargetId** (e.g.
`claude:proj-a`, `claude:proj-b`), and ACP callers pick which one
they want via `--target`.

### CC side — one `a2a-bridge claude` per workspace

Give each workspace a distinct state-dir; the directory's basename
becomes its TargetId id:

```bash
# Terminal 1 — project A
A2A_BRIDGE_STATE_DIR=~/.config/a2a-bridge/proj-a a2a-bridge claude
# → attaches as claude:proj-a

# Terminal 2 — project B
A2A_BRIDGE_STATE_DIR=~/.config/a2a-bridge/proj-b a2a-bridge claude
# → attaches as claude:proj-b
```

Inspect:

```bash
a2a-bridge daemon targets
# TARGET            ATTACHED  CLIENT  UPTIME
# claude:proj-a     yes       3       2m
# claude:proj-b     yes       5       1m
```

If a second attach collides on an already-held TargetId, the daemon
**rejects** it with a descriptive error. Re-run the colliding
`a2a-bridge claude` with `--force` (or set
`A2A_BRIDGE_FORCE_ATTACH=1` in its env) to kick the previous attach
and take over. The evicted session gets a CC-visible notification
that it was replaced.

### ACP side — one registration per target

Add one `acpx` agent entry per target:

```json
{
  "acp": {
    "allowedAgents": ["claude", "codex", "bridge-proj-a", "bridge-proj-b"]
  },
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "agents": {
            "bridge-proj-a": {
              "command": "a2a-bridge",
              "args": [
                "acp",
                "--url", "ws://<SERVER_IP>:4512/ws",
                "--target", "claude:proj-a"
              ]
            },
            "bridge-proj-b": {
              "command": "a2a-bridge",
              "args": [
                "acp",
                "--url", "ws://<SERVER_IP>:4512/ws",
                "--target", "claude:proj-b"
              ]
            }
          }
        }
      }
    }
  }
}
```

Use `/acp spawn bridge-proj-a` / `/acp spawn bridge-proj-b` and
each one routes to its own CC — no cross-talk.

For the full design, deployment shapes, and A2A `contextRoutes`
configuration, see
[`docs/design/multi-target-routing.md`](./design/multi-target-routing.md).

---

## Troubleshooting

- **The install command fails with a 404.** The release may still
  be draft. Ask the user to confirm the release is **published**
  (not just drafted) at
  <https://github.com/firstintent/a2a-bridge/releases>; draft
  assets are not reachable without authentication.

- **`a2a-bridge doctor` reports `FAIL` on a required check.** Run
  `a2a-bridge doctor` on whichever side is failing and follow the
  `fix:` hints — every required-check failure names the exact
  command or environment variable to set.

- **`ACP_SESSION_INIT_FAILED: Failed to spawn agent command`.**
  acpx couldn't exec `a2a-bridge`. Fix it by replacing
  `"command": "a2a-bridge"` with the absolute path
  (`which a2a-bridge`) and splitting flags into the `args` array
  as shown above.

- **`target claude:<id> not attached`.** No CC with that TargetId
  is currently connected. On the CC side, run `a2a-bridge daemon
  targets` to see who's attached; on the ACP side, check the
  `--target` value matches one of those rows.

- **Reply comes back as `Echo: <prompt>`.** The ACP subprocess
  fell back to its echo executor, meaning the daemon routing
  didn't land. Almost always means the daemon is unreachable
  (check `curl http://<SERVER_IP>:4512/healthz`).

- **The smoke prompt times out.** Check `a2a-bridge daemon logs
  --tail 50` on the Claude Code side. The daemon log records each
  `acp_turn_start` / `chunk` / `complete`; if the log shows
  `startTurn` but no reply, the attached Claude Code session is
  the stuck party.

- **Config already exists on first-run.** `a2a-bridge init` never
  overwrites an existing token unless you pass `--force`. Tell the
  user: the previous token is fine to reuse, and they can print it
  again with `a2a-bridge init --print`.

---

## What this skill does not do

- It does **not** configure the A2A HTTP inbound (Gemini CLI
  `remoteAgents`) — `init` prints the snippet, but adding it to
  the Gemini CLI config is the user's call.
- It does **not** set up TLS. v0.2 supports cross-host deployment
  via `A2A_BRIDGE_CONTROL_HOST=0.0.0.0`, but the daemon terminates
  plaintext WebSocket. Put a TLS proxy in front if the link leaves
  your trust boundary.
- It does **not** run `npm publish` or submit the Claude Code
  marketplace / ACP registry packages — those are credentialed
  maintainer steps.

For the full design — why this is built as two halves instead of a
single end-to-end protocol — see
[`docs/design/architecture.md`](./design/architecture.md) and
[`docs/design/positioning.md`](./design/positioning.md).
