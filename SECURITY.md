# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AgentBridge, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: [rayson951005@gmail.com](mailto:rayson951005@gmail.com)

We will acknowledge your report within 48 hours and provide an estimated timeline for a fix.

## Security Considerations

AgentBridge runs locally on your machine and involves:

- **Local WebSocket connections** between Claude Code, the bridge daemon, and Codex app-server. All connections are on `127.0.0.1` — no external network exposure by default.
- **MCP stdio communication** between Claude Code and the bridge process.
- **Command execution**: The bridge spawns `codex app-server` as a subprocess. Ensure you trust the Codex CLI installed on your system.
- **Message forwarding**: All messages between Claude Code and Codex pass through the bridge. The bridge does not filter or sanitize message content — both agents may execute code based on received messages.

## Trust Boundary

This project uses Claude Code's **Channels** feature, which is currently a **Research Preview**. When launching with `--dangerously-load-development-channels`, you are granting the channel (AgentBridge) the ability to inject messages into your Claude Code session. Only use channels you trust.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
