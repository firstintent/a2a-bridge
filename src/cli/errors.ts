/**
 * Friendly CLI error helpers (P6.4).
 *
 * Every helper returns a `{ cause, fix }` pair: a one-line description
 * of what went wrong plus a one-line recommendation for the next step
 * the user should take. Callers render the pair through
 * `renderFriendlyError` to get the two-line `error: ... / fix: ...`
 * block the CLI prints to stderr.
 *
 * Helpers are pure formatters — they do not detect errors or read
 * environment. Detection lives at call sites; the shape here keeps
 * wording consistent across subcommands.
 */

export interface FriendlyError {
  /** One-line cause describing what went wrong. */
  cause: string;
  /** One-line recommendation naming the command or env var to try. */
  fix: string;
}

export function formatBindInUse(port: number): FriendlyError {
  return {
    cause: `Port ${port} is already in use — another process is listening there.`,
    fix: "Stop the other process, or set A2A_BRIDGE_A2A_PORT to a free port before restarting.",
  };
}

export function formatMissingBearerToken(): FriendlyError {
  return {
    cause: "No bearer token configured — the A2A inbound endpoint cannot authenticate callers.",
    fix: "Run `a2a-bridge init` to mint one, or export A2A_BRIDGE_BEARER_TOKEN in the daemon's environment.",
  };
}

export function formatMissingCcPlugin(): FriendlyError {
  return {
    cause: "The Claude Code channel plugin is not installed — Claude Code cannot reach the daemon.",
    fix: "Run `a2a-bridge init` (or `a2a-bridge dev` for local development) to install the plugin.",
  };
}

export function formatMissingAcpSdk(): FriendlyError {
  return {
    cause: "@agentclientprotocol/sdk is not installed — the ACP inbound service cannot boot.",
    fix: "Run `bun install` in the a2a-bridge project root to fetch the SDK from npm.",
  };
}

export function formatDaemonUnreachable(url: string): FriendlyError {
  return {
    cause: `a2a-bridge acp cannot reach the daemon at ${url}.`,
    fix: "Run `a2a-bridge daemon start` (or `a2a-bridge init` for a first-time setup) and retry.",
  };
}

export function renderFriendlyError(err: FriendlyError): string {
  return `error: ${err.cause}\n  fix: ${err.fix}`;
}

/**
 * Error thrown by `runAcp()` when the daemon cannot be reached.  The CLI
 * entry point catches this, renders `friendly` to stderr, and exits
 * non-zero; tests catch it to assert the failure mode without tripping
 * `process.exit`.
 */
export class DaemonUnreachableError extends Error {
  readonly friendly: FriendlyError;
  constructor(url: string, cause?: Error) {
    const friendly = formatDaemonUnreachable(url);
    super(friendly.cause + (cause ? ` (${cause.message})` : ""));
    this.name = "DaemonUnreachableError";
    this.friendly = friendly;
  }
}
