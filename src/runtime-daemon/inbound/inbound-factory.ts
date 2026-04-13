import type { IInboundService } from "@daemon/inbound/inbound-service";
import { A2aHttpInboundService, type A2aHttpConfig } from "@daemon/inbound/a2a-http";
import { AcpInboundService, type AcpInboundConfig } from "@daemon/inbound/acp";

/** Identifier strings a user/config picks from. */
export type InboundKind = "a2a-http" | "acp-stdio";

export type InboundFactoryOptions =
  | ({ kind: "a2a-http" } & A2aHttpConfig)
  | ({ kind: "acp-stdio" } & AcpInboundConfig);

/**
 * Build an inbound service from a kind-tagged config. Unknown kinds
 * throw so config typos fail loudly at startup rather than later when
 * the first client connects.
 *
 * `a2a-http` is wired today; `acp-stdio` is a P5.2 stub that lets
 * config / CLI code refer to the kind before the service implementation
 * arrives in P5.3+. Each new inbound protocol adds one case here.
 */
export function createInboundService(opts: InboundFactoryOptions): IInboundService {
  switch (opts.kind) {
    case "a2a-http":
      return new A2aHttpInboundService(opts);
    case "acp-stdio":
      return new AcpInboundService(opts);
    default: {
      const _exhaustive: never = opts;
      throw new Error(`Unknown inbound kind: ${String(_exhaustive)}`);
    }
  }
}
