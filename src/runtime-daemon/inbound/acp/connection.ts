/**
 * ACP inbound — `AgentSideConnection` glue.
 *
 * Callers supply an in-memory Web-stream pair (TransformStream-based
 * pipes in unit tests, Bun's `stdin.stream()` / stdout-writer in the
 * CLI). `ndJsonStream` wraps the pair into the JSON-RPC `Stream` the
 * ACP SDK expects.
 */

import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

export interface AcpStdioPair {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
}

/** Build the SDK's JSON-RPC `Stream` from a raw byte pair. */
export function buildAcpStream(pair: AcpStdioPair): Stream {
  return ndJsonStream(pair.output, pair.input);
}
