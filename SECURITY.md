# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in cc-bridge, please report it
responsibly.

**Do not open a public GitHub issue for security vulnerabilities.** Instead,
open a private advisory through GitHub Security Advisories on
<https://github.com/firstintent/cc-bridge/security/advisories>.

## Security Considerations

cc-bridge can run in two deployment shapes:

- **Local only**: the daemon and Claude Code run on the same host. All
  traffic stays on loopback.
- **Remote daemon**: the daemon runs on a separate host from Claude Code. In
  this mode the plugin<->daemon control channel MUST be TLS-terminated and
  bearer-token authenticated; never expose the daemon on a public network
  without both.

Regardless of shape, the bridge involves:

- **Peer subprocess or network calls**: the daemon connects to peer agents
  (Codex, OpenClaw, Hermes, ...) that can execute code on behalf of the
  session. Trust the peer before wiring it in.
- **MCP stdio communication** between Claude Code and the bridge plugin.
- **Message forwarding**: messages traverse the bridge unfiltered; both
  sides may act on content they receive.

## Trust Boundary

cc-bridge uses Claude Code's **Channels** feature (currently a Research
Preview). Launching with `--dangerously-load-development-channels` grants
the channel the ability to inject messages into your Claude Code session.
Only enable channels and peers you trust.

## Supported Versions

Pre-1.0 — only the latest `0.x` release is supported.
