/**
 * ACP inbound — `AgentSideConnection` glue (placeholder, P5.2).
 *
 * Real wiring lands in P5.3 (initialize + newSession) and P5.4 (prompt
 * → ClaudeCodeGateway). This module exists now so future ACP files
 * have a stable home for the `@agentclientprotocol/sdk` adapter.
 *
 * Minimal stdio-pair shape — lets callers supply any Node `Readable`
 * in and `Writable` out (stdin/stdout in production, in-memory pipes
 * in unit tests). P5.3 will bind this to `AgentSideConnection`.
 */

import type { Readable, Writable } from "node:stream";

export interface AcpStdioPair {
  input: Readable;
  output: Writable;
}
