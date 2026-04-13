/**
 * `a2a-bridge acp` CLI subcommand (P5.6).
 *
 * Speaks ACP over `process.stdin` / `process.stdout` using
 * `AcpInboundService`. Auto-starts the long-running daemon (same
 * heuristic the `claude` / `codex` subcommands use) so any future
 * gateway wiring that relies on the daemon's control plane has a
 * live target to talk to.
 *
 * v0.1 note: the subcommand ships with an in-process **echo gateway**
 * that replies `Echo: <user text>` so clients get a deterministic
 * round-trip. Daemon-backed ACP routing (ACP → daemon → CC) is a
 * post-v0.1 item; it'll replace the echo gateway with a
 * `DaemonProxyGateway` that forwards turns over the control plane.
 */

import { EventEmitter } from "node:events";
import { DaemonLifecycle } from "@shared/daemon-lifecycle";
import { StateDirResolver } from "@shared/state-dir";
import { AcpInboundService } from "@daemon/inbound/acp";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";
import type { AcpStdioPair } from "@daemon/inbound/acp/connection";

class EchoTurn extends EventEmitter implements ClaudeCodeTurn {
  cancel(): void {}
}

class EchoGateway implements ClaudeCodeGateway {
  startTurn(userText: string): ClaudeCodeTurn {
    const turn = new EchoTurn();
    // Emit async so the handler has its listeners wired up.
    setImmediate(() => {
      turn.emit("chunk", `Echo: ${userText}`);
      turn.emit("complete");
    });
    return turn;
  }
}

export interface RunAcpOptions {
  stdio?: AcpStdioPair;
  ensureDaemon?: boolean;
}

export async function runAcp(
  args: string[],
  options: RunAcpOptions = {},
): Promise<AcpInboundService> {
  void args;

  const ensureDaemon =
    options.ensureDaemon ?? process.env.A2A_BRIDGE_ACP_SKIP_DAEMON !== "1";
  if (ensureDaemon) {
    const stateDir = new StateDirResolver();
    const controlPort = parseInt(process.env.A2A_BRIDGE_CONTROL_PORT ?? "4512", 10);
    const lifecycle = new DaemonLifecycle({
      stateDir,
      controlPort,
      log: (msg) => console.error(`[a2a-bridge] ${msg}`),
    });
    try {
      await lifecycle.ensureRunning();
    } catch (err) {
      // The daemon is a nice-to-have for future wiring; don't block the
      // ACP server from running with the echo gateway if it's down.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[a2a-bridge acp] daemon unavailable (${reason}); continuing with echo gateway`);
    }
  }

  const stdio = options.stdio ?? defaultStdio();
  const service = new AcpInboundService({
    stdio,
    gateway: new EchoGateway(),
  });
  await service.start();
  return service;
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
