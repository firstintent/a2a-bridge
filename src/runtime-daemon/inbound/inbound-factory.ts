import type { IInboundService } from "@daemon/inbound/inbound-service";
import { A2aHttpInboundService, type A2aHttpConfig } from "@daemon/inbound/a2a-http";

/** Identifier strings a user/config picks from. */
export type InboundKind = "a2a-http";

export type InboundFactoryOptions =
  | ({ kind: "a2a-http" } & A2aHttpConfig);

/**
 * Build an inbound service from a kind-tagged config. Unknown kinds
 * throw so config typos fail loudly at startup rather than later when
 * the first client connects.
 *
 * Only `a2a-http` is wired today. Additional inbound protocols land
 * here as their services are added; each adds one case.
 */
export function createInboundService(opts: InboundFactoryOptions): IInboundService {
  switch (opts.kind) {
    case "a2a-http":
      return new A2aHttpInboundService(opts);
    default: {
      const _exhaustive: never = opts.kind;
      throw new Error(`Unknown inbound kind: ${String(_exhaustive)}`);
    }
  }
}
