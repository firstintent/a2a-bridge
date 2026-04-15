import { spawn } from "node:child_process";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "./constants";
import { DaemonLifecycle } from "@shared/daemon-lifecycle";
import { StateDirResolver } from "@shared/state-dir";

/** Flags that A2aBridge owns and will inject automatically. */
const OWNED_FLAGS = ["--channels", "--dangerously-load-development-channels"];

export async function runClaude(args: string[]) {
  // P10.6 — strip our own `--force` flag before CC sees it, and
  // forward it to the plugin via env. CC itself doesn't know what
  // `--force` means for the daemon attach.
  const { forwarded, force } = extractForceFlag(args);

  // Check for owned flag conflicts
  checkOwnedFlagConflicts(forwarded, "a2a-bridge claude", OWNED_FLAGS);

  const stateDir = new StateDirResolver();
  const controlPort = parseInt(process.env.A2A_BRIDGE_CONTROL_PORT ?? "4512", 10);
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.error(`[a2a-bridge] ${msg}`),
  });

  lifecycle.clearKilled();

  // Channel entry format: "server:<mcp-server-name>" for MCP-based channels,
  // or "plugin:<plugin>@<marketplace>" for plugin-based channels.
  // A2aBridge is installed as a plugin, so use the plugin channel format.
  const channelEntry = `plugin:${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

  // Only use --dangerously-load-development-channels for now.
  // --channels checks the approved allowlist (Anthropic-curated) and fails
  // for custom plugins. The dev flag bypasses this per-entry.
  // Once published to the official marketplace, switch to --channels.
  const fullArgs = [
    "--dangerously-load-development-channels", channelEntry,
    ...forwarded,
  ];

  const child = spawn("claude", fullArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(force ? { A2A_BRIDGE_FORCE_ATTACH: "1" } : {}),
    },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: claude not found in PATH.");
      console.error("Install Claude Code: npm install -g @anthropic-ai/claude-code");
      process.exit(1);
    }
    console.error(`Error starting Claude Code: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Extract the P10.6 `--force` flag from a raw argv. Returns the
 * forwarded-through args (minus `--force`) and a boolean saying
 * whether the flag was present. Exported for unit tests.
 */
export function extractForceFlag(args: string[]): { forwarded: string[]; force: boolean } {
  const forwarded: string[] = [];
  let force = false;
  for (const arg of args) {
    if (arg === "--force") {
      force = true;
    } else {
      forwarded.push(arg);
    }
  }
  return { forwarded, force };
}

/**
 * Check if user passed any A2aBridge-owned flags.
 * Hard error if they did — mixed flag state is unpredictable.
 */
export function checkOwnedFlagConflicts(
  args: string[],
  commandName: string,
  ownedFlags: string[],
) {
  for (const flag of ownedFlags) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) {
      console.error(`Error: "${flag}" is automatically set by ${commandName}.`);
      console.error("");
      console.error("A2aBridge automatically injects these flags:");
      for (const f of ownedFlags) {
        console.error(`  ${f}`);
      }
      console.error("");
      const nativeCmd = commandName.includes("codex") ? "codex" : "claude";
      console.error("If you need full control over these flags, use the native command directly:");
      console.error(`  ${nativeCmd} [your flags here]`);
      process.exit(1);
    }
  }
}
