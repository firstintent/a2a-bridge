#!/usr/bin/env bun

/**
 * A2aBridge CLI
 *
 * Commands:
 *   a2a-bridge init        — Install plugin, check deps, generate project config
 *   a2a-bridge dev         — Register local marketplace + install plugin for local dev
 *   a2a-bridge claude      — Start Claude Code with push channel flags
 *   a2a-bridge codex       — Start Codex TUI connected to daemon
 *   a2a-bridge acp         — Start ACP-over-stdio server for Zed/OpenClaw/VS Code
 *   a2a-bridge kill        — Force kill all A2aBridge processes
 */

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

// Re-export for external callers; the canonical source is ./constants.
export { MARKETPLACE_NAME, PLUGIN_NAME } from "./constants";

async function main() {
  switch (command) {
    case "init":
      const { runInit } = await import("./init");
      await runInit(restArgs);
      break;
    case "dev":
      const { runDev } = await import("./dev");
      await runDev();
      break;
    case "claude":
      const { runClaude } = await import("./claude");
      await runClaude(restArgs);
      break;
    case "codex":
      const { runCodex } = await import("./codex");
      await runCodex(restArgs);
      break;
    case "acp":
      const { runAcp } = await import("./acp");
      await runAcp(restArgs);
      break;
    case "doctor":
      const { runDoctor } = await import("./doctor");
      {
        const result = await runDoctor();
        if (result.exitCode !== 0) process.exit(result.exitCode);
      }
      break;
    case "kill":
      const { runKill } = await import("./kill");
      await runKill();
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    case "--version":
    case "-v":
      printVersion();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run "a2a-bridge --help" (or "abg --help") for usage.`);
      process.exit(1);
  }
}

function printHelp() {
  console.log(`
A2aBridge — Multi-agent collaboration bridge

Usage:
  a2a-bridge <command> [args...]
  abg <command> [args...]

Commands:
  init              Install plugin, check dependencies, generate project config
  dev               Register local marketplace + install plugin (for local dev)
  claude [args...]  Start Claude Code with push channel enabled
  codex [args...]   Start Codex TUI connected to A2aBridge daemon
  acp [args...]     Start ACP-over-stdio server (for Zed / OpenClaw / VS Code)
  doctor            Run preflight checks (bun, ports, SDK, plugin, state-dir)
  kill              Force kill all A2aBridge processes

Options:
  --help, -h        Show this help message
  --version, -v     Show version

Examples:
  abg init                     # First-time setup
  abg claude                   # Start Claude Code
  abg claude --resume          # Start Claude Code and resume session
  abg codex                    # Start Codex TUI
  abg codex --model o3         # Start Codex with specific model
  abg kill                     # Emergency: kill all processes
`.trim());
}

function printVersion() {
  try {
    const pkg = require("../package.json");
    console.log(`a2a-bridge v${pkg.version}`);
  } catch {
    console.log("a2a-bridge (version unknown)");
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
