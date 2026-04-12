/**
 * Bearer-token request guard for the A2A HTTP surface.
 *
 * Clients authenticate with `Authorization: Bearer <token>`. The
 * `/.well-known/agent-card.json` endpoint can be exempted via
 * `publicAgentCard: true` so discovery works before a token is
 * configured client-side (the pattern the A2A SDK uses today).
 */

export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export interface AuthConfig {
  /** Bearer token clients must present. Empty values are treated as bad config. */
  bearerToken: string;
  /** When true, `GET /.well-known/agent-card.json` bypasses auth. */
  publicAgentCard?: boolean;
}

/**
 * Return `null` if the request may proceed, or a `401` Response if not.
 * Constant-time comparison isn't used — the token is a shared secret,
 * not a hashed value, and the A2A flow does not protect against
 * timing-oracle attacks at this layer.
 */
export function checkBearerAuth(req: Request, config: AuthConfig): Response | null {
  const url = new URL(req.url);

  if (config.publicAgentCard && url.pathname === AGENT_CARD_PATH) {
    return null;
  }

  const header = req.headers.get("authorization");
  if (!header) {
    return unauthorized("missing Authorization header");
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return unauthorized("invalid Authorization header format");
  }

  const presented = match[1]!.trim();
  if (!config.bearerToken || presented !== config.bearerToken) {
    return unauthorized("bad bearer token");
  }

  return null;
}

function unauthorized(reason: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", reason }), {
    status: 401,
    headers: {
      "www-authenticate": 'Bearer realm="a2a-bridge"',
      "content-type": "application/json",
    },
  });
}
