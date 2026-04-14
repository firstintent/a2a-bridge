/**
 * `a2a-bridge acp` CLI subcommand.
 *
 * Speaks ACP over `process.stdin` / `process.stdout` using
 * `AcpInboundService`.  The default (production) path relays every
 * turn through the daemon's control plane via `DaemonProxyGateway`
 * so the ACP client gets real Claude Code output, not an echo.
 *
 * When the daemon is unreachable the subcommand fails loudly — it
 * throws `DaemonUnreachableError`, which the CLI entry point renders
 * as a friendly two-line error and exits non-zero.  Silent fall-back
 * to echo was a v0.1 pre-release behaviour (Phase 8 removes it;
 * `EchoGateway` now lives only in test code).
 *
 * Tests drive `runAcp` with an injected gateway so they can exercise
 * the ACP surface without a running daemon.
 */

import { DaemonLifecycle } from "@shared/daemon-lifecycle";
import { StateDirResolver } from "@shared/state-dir";
import { AcpInboundService } from "@daemon/inbound/acp";
import { DaemonProxyGateway } from "@daemon/inbound/acp/daemon-proxy-gateway";
import type { ClaudeCodeGateway } from "@daemon/inbound/a2a-http/claude-code-gateway";
import type { AcpStdioPair } from "@daemon/inbound/acp/connection";
import {
  DaemonUnreachableError,
  renderFriendlyError,
} from "./errors";

export interface RunAcpOptions {
  /** stdio pair for the ACP agent. Defaults to `process.stdin` / `process.stdout`. */
  stdio?: AcpStdioPair;
  /** When false, skip the daemon-lifecycle check (auto-start). */
  ensureDaemon?: boolean;
  /** Override the daemon control-plane WebSocket URL. */
  controlWsUrl?: string;
  /**
   * Test-only escape hatch: when provided, skips the daemon entirely
   * and uses this gateway directly.  Production callers never set this.
   */
  gateway?: ClaudeCodeGateway;
}

export async function runAcp(
  args: string[],
  options: RunAcpOptions = {},
): Promise<AcpInboundService | void> {
  // One-shot prompt mode: a2a-bridge acp -p "hello" / --prompt "hello"
  const promptIdx = args.findIndex((a) => a === "-p" || a === "--prompt");
  if (promptIdx !== -1) {
    const text = args[promptIdx + 1];
    if (!text) {
      console.error("Usage: a2a-bridge acp -p <prompt>");
      process.exit(1);
    }
    return runOneShotPrompt(text, options);
  }

  const stdio = options.stdio ?? defaultStdio();
  const gateway = await resolveGateway(options);

  const service = new AcpInboundService({ stdio, gateway });
  await service.start();
  return service;
}

/**
 * One-shot mode: connect to daemon, send one prompt, print the reply,
 * exit. Useful for smoke-testing the bridge from the command line.
 */
async function runOneShotPrompt(
  text: string,
  options: RunAcpOptions,
): Promise<void> {
  const gateway = await resolveGateway(options);
  const turn = gateway.startTurn(text);

  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    turn.on("chunk", (c: string) => chunks.push(c));
    turn.on("complete", () => resolve());
    turn.on("error", (err: Error) => reject(err));
  });

  const reply = chunks.join("");
  console.log(reply);

  // Clean shutdown
  if ("disconnect" in gateway && typeof gateway.disconnect === "function") {
    await (gateway as { disconnect: () => Promise<void> }).disconnect();
  }
}

async function resolveGateway(options: RunAcpOptions): Promise<ClaudeCodeGateway> {
  if (options.gateway) return options.gateway;

  const controlPort = parseInt(process.env.A2A_BRIDGE_CONTROL_PORT ?? "4512", 10);
  const controlHost = process.env.A2A_BRIDGE_CONTROL_HOST ?? "127.0.0.1";
  const controlWsUrl =
    options.controlWsUrl ??
    process.env.A2A_BRIDGE_CONTROL_URL ??
    `ws://${controlHost}:${controlPort}/ws`;

  // Default: skip daemon auto-start. ACP clients are typically on a
  // different machine from the daemon; trying to ensureRunning locally
  // just wastes time and confuses users behind proxies. Set
  // A2A_BRIDGE_ACP_ENSURE_DAEMON=1 to opt back in.
  const ensureDaemon =
    options.ensureDaemon ?? process.env.A2A_BRIDGE_ACP_ENSURE_DAEMON === "1";

  if (ensureDaemon) {
    const stateDir = new StateDirResolver();
    const lifecycle = new DaemonLifecycle({
      stateDir,
      controlPort,
      log: (msg) => console.error(`[a2a-bridge acp] ${msg}`),
    });
    try {
      await lifecycle.ensureRunning();
    } catch (err) {
      throw new DaemonUnreachableError(
        controlWsUrl,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  const gateway = new DaemonProxyGateway({
    url: controlWsUrl,
    log: (msg) => console.error(`[a2a-bridge acp] ${msg}`),
  });
  try {
    await gateway.connect();
  } catch (err) {
    throw new DaemonUnreachableError(
      controlWsUrl,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
  return gateway;
}

/**
 * Entry-point wrapper used by the CLI dispatcher.  Catches
 * `DaemonUnreachableError`, prints the friendly error block, and
 * exits non-zero so ACP clients see a clean failure instead of a
 * zombie subprocess echoing their input.
 */
export async function runAcpCli(args: string[]): Promise<void> {
  try {
    await runAcp(args);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      console.error(renderFriendlyError(err.friendly));
      process.exit(1);
    }
    throw err;
  }
}

function defaultStdio(): AcpStdioPair {
  // Bun exposes web-stream views of the process streams; fall back
  // gracefully if anything is missing (not expected in the real CLI).
  const input =
    (process.stdin as unknown as { stream?: () => ReadableStream<Uint8Array> }).stream?.() ??
    (Bun.stdin.stream() as ReadableStream<Uint8Array>);
  const output: WritableStream<Uint8Array> = new WritableStream<Uint8Array>({
    write(chunk) {
      process.stdout.write(chunk);
    },
  });
  return { input, output };
}
