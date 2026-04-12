import type { IInboundService } from "@daemon/inbound/inbound-service";

/**
 * A2A-over-HTTP inbound service stub.
 *
 * Real implementation lands in later Phase 2 tasks — agent card,
 * bearer auth, JSON-RPC dispatcher, and the `message/stream` SSE
 * handler. This file exists so the factory has something to dispatch
 * to and so import boundaries settle early.
 */

export interface A2aHttpConfig {
  /** Host to bind; defaults to 127.0.0.1. */
  host?: string;
  /** TCP port to bind. */
  port: number;
  /** Bearer token required on the JSON-RPC endpoint. */
  bearerToken: string;
  /** If true, the agent-card endpoint is served without auth. */
  publicAgentCard?: boolean;
}

export class A2aHttpInboundService implements IInboundService {
  readonly kind = "a2a-http";

  constructor(_config: A2aHttpConfig) {
    // Config is consumed in later tasks (server bind, auth, card).
  }

  async start(): Promise<void> {
    throw new Error("A2aHttpInboundService.start not implemented yet");
  }

  async stop(): Promise<void> {
    // No-op until start() is implemented.
  }
}
