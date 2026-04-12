import type { IPeerAdapter } from "./peer-adapter";
import { CodexAdapter } from "./codex-adapter";

/** Identifier strings a user/config picks from. */
export type PeerKind = "codex" | "openclaw" | "hermes";

export interface PeerFactoryOptions {
  /** Which peer implementation to build. */
  kind: PeerKind;
  /**
   * Codex-only: app-server and proxy ports. OpenClaw and Hermes adapters
   * will accept their own shapes when they land; callers pass the whole
   * opts object through so each adapter picks what it needs.
   */
  codex?: { appPort?: number; proxyPort?: number };
}

/**
 * Build a peer adapter from a kind string. Unknown kinds throw so that
 * config typos fail loudly at startup rather than later during a turn.
 *
 * Only CodexAdapter is wired today. OpenClaw and Hermes land here as
 * their adapters are added in later commits; each adds one case.
 */
export function createPeerAdapter(opts: PeerFactoryOptions): IPeerAdapter {
  switch (opts.kind) {
    case "codex": {
      const cfg = opts.codex ?? {};
      return new CodexAdapter(cfg.appPort, cfg.proxyPort);
    }
    case "openclaw":
      throw new Error("OpenClaw adapter not yet implemented");
    case "hermes":
      throw new Error("Hermes adapter not yet implemented");
    default: {
      const _exhaustive: never = opts.kind;
      throw new Error(`Unknown peer kind: ${String(_exhaustive)}`);
    }
  }
}
