/**
 * ACP-over-stdio inbound service stub.
 *
 * The real implementation lands in later Phase 5 tasks:
 *   - P5.3: initialize + newSession handshake using
 *     `@agentclientprotocol/sdk`'s `AgentSideConnection`.
 *   - P5.4: bridge `prompt` into the shared `ClaudeCodeGateway`.
 *   - P5.5: wire `cancel` to turn cancellation.
 *
 * P5.2 exists only to plug into the daemon's `inbound-factory` switch
 * and to give P5.3+ a stable import surface — no behavior yet.
 */

import type { IInboundService } from "@daemon/inbound/inbound-service";
import type { AcpStdioPair } from "@daemon/inbound/acp/connection";

export interface AcpInboundConfig {
  /**
   * stdio pair the ACP server reads from / writes to. When omitted,
   * P5.6's `a2a-bridge acp` CLI binds `process.stdin` / `process.stdout`.
   */
  stdio?: AcpStdioPair;
}

export class AcpInboundService implements IInboundService {
  readonly kind = "acp-stdio";

  constructor(_config: AcpInboundConfig) {
    // Config is consumed in P5.3+ (handshake, gateway wiring, cancel).
    void _config;
  }

  async start(): Promise<void> {
    throw new Error("AcpInboundService.start not implemented yet (P5.3)");
  }

  async stop(): Promise<void> {
    // No-op until start() exists.
  }
}
