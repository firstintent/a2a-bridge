/**
 * Contract every inbound service implementation must satisfy.
 *
 * An inbound service exposes Claude Code to an external-agent protocol
 * (A2A-over-HTTP today; others can plug in later). The daemon owns one
 * or more `IInboundService` instances and drives them uniformly through
 * this interface.
 *
 * Wiring to Claude Code lives outside this contract — each service
 * routes accepted work into the daemon's room/peer path via a callback
 * supplied at construction time.
 */
export interface IInboundService {
  /** Stable identifier for logging/config (e.g. "a2a-http"). */
  readonly kind: string;

  /**
   * Begin accepting inbound traffic. Resolves once the endpoint is live.
   * Rejects if the endpoint cannot be bound.
   */
  start(): Promise<void>;

  /**
   * Stop accepting new traffic and tear down any in-flight sessions.
   * Resolves once resources are released. Safe to call more than once.
   */
  stop(): Promise<void>;
}
