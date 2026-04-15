/**
 * Workspace id derivation for the Claude Code plugin (P10.2).
 *
 * Resolves the `id` half of `claude:<id>` from environment + state-dir,
 * following the priority chain in
 * docs/design/multi-target-routing.md §"Default id derivation".
 */

import { basename } from "node:path";
import { DEFAULT_INSTANCE_ID, parseTarget } from "@shared/target-id";

export interface ResolveWorkspaceIdOptions {
  /** Optional state-dir path; basename is used when env vars are absent. */
  stateDirPath?: string;
  /** Optional CC conversation id, first 8 chars used as fallback. */
  conversationId?: string;
  /** Override for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Derive the CC workspace id following the documented priority chain:
 *   1. A2A_BRIDGE_WORKSPACE_ID (explicit override)
 *   2. basename of A2A_BRIDGE_STATE_DIR (or stateDirPath)
 *   3. first 8 chars of conversationId
 *   4. "default"
 *
 * The returned id is **always identifier-safe** (`[a-z0-9_-]+`):
 * any disallowed characters in derived sources are replaced with `-`,
 * leading/trailing `-` are stripped, and an empty result falls through
 * to the next source. This guarantees `claude:<id>` parses cleanly.
 */
export function resolveWorkspaceId(opts: ResolveWorkspaceIdOptions = {}): string {
  const env = opts.env ?? process.env;

  // 1. Explicit override
  const override = env.A2A_BRIDGE_WORKSPACE_ID;
  const overrideClean = override && sanitize(override);
  if (overrideClean) return overrideClean;

  // 2. State-dir basename
  const stateDir = opts.stateDirPath ?? env.A2A_BRIDGE_STATE_DIR;
  if (stateDir) {
    const stateClean = sanitize(basename(stateDir));
    if (stateClean) return stateClean;
  }

  // 3. Conversation id prefix
  if (opts.conversationId) {
    const convClean = sanitize(opts.conversationId.slice(0, 8));
    if (convClean) return convClean;
  }

  // 4. Fallback
  return DEFAULT_INSTANCE_ID;
}

/** Build the full TargetId string `claude:<id>` from the same options. */
export function resolveClaudeTarget(opts: ResolveWorkspaceIdOptions = {}): string {
  const id = resolveWorkspaceId(opts);
  const r = parseTarget(`claude:${id}`);
  if (!r.ok) {
    // Should be unreachable — sanitize() guarantees identifier-safe output.
    throw new Error(`resolveClaudeTarget produced invalid target: ${r.error}`);
  }
  return r.target;
}

function sanitize(value: string): string {
  // Lowercase, then replace any character outside [a-z0-9_-] with `-`,
  // collapse runs of `-`, strip leading/trailing `-`. Empty result
  // signals "this source did not produce a usable id".
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
