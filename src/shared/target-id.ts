/**
 * TargetId — a `kind:id` tuple identifying an agent instance the
 * daemon routes to (P10.1, design: docs/design/multi-target-routing.md).
 *
 * Every agent instance — a Claude Code workspace, a Codex peer, a
 * Hermes peer, etc. — has a TargetId. `kind` names the agent family
 * ("claude", "codex", ...); `id` disambiguates instances inside that
 * family ("project-a", "dev", ...). There is no "bare kind" — every
 * target has an explicit id; when the caller omits one, `parseTarget`
 * fills it in as "default".
 *
 * Branded string form: `"<kind>:<id>"`. Both fields must be
 * identifier-safe (`[a-z0-9_-]+`) so the string survives transport
 * layers that silently drop non-identifier characters (notably
 * `notifications/claude/channel` meta keys — see the permission
 * bridge's `assertIdentifierSafeKeys`).
 */

declare const TargetIdBrand: unique symbol;
export type TargetId = string & { [TargetIdBrand]: true };

/** Structural form of a parsed target. */
export interface TargetParts {
  kind: string;
  id: string;
}

export const DEFAULT_INSTANCE_ID = "default";

const VALID_SEGMENT = /^[a-z0-9_-]+$/;

export type ParseTargetResult =
  | { ok: true; target: TargetId; parts: TargetParts }
  | { ok: false; error: string };

/**
 * Parse a target specifier into a normalised `kind:id` TargetId.
 *
 * - `"claude:project-a"` → `{kind: "claude", id: "project-a"}`
 * - `"claude"` → `{kind: "claude", id: "default"}` (id defaults)
 * - `"Claude:Foo"` or `"claude:foo bar"` → error (only [a-z0-9_-])
 * - `""` / `":foo"` / `"foo:"` → error (empty segment)
 * - `"a:b:c"` → error (multiple separators)
 */
export function parseTarget(input: string): ParseTargetResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "Target specifier must be a non-empty string" };
  }

  const parts = input.split(":");
  if (parts.length > 2) {
    return {
      ok: false,
      error: `Target "${input}" has multiple ':' separators; expected "kind" or "kind:id"`,
    };
  }

  const kind = parts[0] ?? "";
  const id = parts.length === 2 ? (parts[1] ?? "") : DEFAULT_INSTANCE_ID;

  if (kind.length === 0) {
    return { ok: false, error: `Target "${input}" has an empty kind` };
  }
  if (!VALID_SEGMENT.test(kind)) {
    return {
      ok: false,
      error: `Target kind "${kind}" contains characters outside [a-z0-9_-]`,
    };
  }
  if (id.length === 0) {
    return { ok: false, error: `Target "${input}" has an empty id` };
  }
  if (!VALID_SEGMENT.test(id)) {
    return {
      ok: false,
      error: `Target id "${id}" contains characters outside [a-z0-9_-]`,
    };
  }

  return {
    ok: true,
    target: `${kind}:${id}` as TargetId,
    parts: { kind, id },
  };
}

/** Inverse of `parseTarget` — format `{kind, id}` as a TargetId string. */
export function formatTarget(parts: TargetParts): TargetId {
  const combined = `${parts.kind}:${parts.id}`;
  const parsed = parseTarget(combined);
  if (!parsed.ok) {
    throw new Error(`formatTarget: invalid parts ${JSON.stringify(parts)} — ${parsed.error}`);
  }
  return parsed.target;
}

/**
 * Assert that a caller-supplied string is a valid TargetId and throw
 * a descriptive Error otherwise. Returns the branded TargetId.
 */
export function assertTarget(input: string): TargetId {
  const r = parseTarget(input);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}
