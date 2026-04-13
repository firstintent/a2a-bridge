/**
 * A2A Agent Card generator.
 *
 * Shape and field names follow the A2A SDK (camelCase) and the
 * "Agent Card fields" section of docs/design/architecture.md. The SDK's client
 * validates a minimum of these fields, so any missing required key
 * fails Gemini-CLI-style callers.
 */

export interface AgentSkill {
  /** Stable identifier; the A2A spec requires this to be unique within a card. */
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

export interface HttpBearerSecurityScheme {
  type: "http";
  scheme: "bearer";
  description?: string;
}

export type AgentSecurityScheme = HttpBearerSecurityScheme;

export interface AgentCard {
  protocolVersion: "0.3.0";
  name: string;
  description: string;
  version: string;
  /** Absolute URL of the JSON-RPC endpoint. */
  url: string;
  capabilities: { streaming: true };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  securitySchemes: Record<string, AgentSecurityScheme>;
  security: Array<Record<string, string[]>>;
}

export interface AgentCardConfig {
  /** Absolute URL the card advertises as the JSON-RPC endpoint. */
  url: string;
  /** Overrides for the default metadata; any field omitted falls back. */
  name?: string;
  description?: string;
  version?: string;
  /** Replace the default skill list entirely. Must be non-empty. */
  skills?: AgentSkill[];
  /** Extra output modes appended to the default `text/plain`. */
  extraOutputModes?: string[];
}

const DEFAULT_SKILL: AgentSkill = {
  id: "delegate-to-claude-code",
  name: "Delegate to Claude Code",
  description:
    "Send a message to the paired Claude Code session and receive the streamed assistant response back.",
  tags: ["code", "agent", "claude-code"],
  examples: [
    "Review this patch and tell me if the auth logic looks right.",
    "Summarize the last ten commits on this branch.",
  ],
};

export function buildAgentCard(config: AgentCardConfig): AgentCard {
  const skills = config.skills ?? [DEFAULT_SKILL];
  if (skills.length === 0) {
    throw new Error("buildAgentCard: skills must contain at least one entry");
  }

  return {
    protocolVersion: "0.3.0",
    name: config.name ?? "a2a-bridge",
    description:
      config.description ??
      "Claude Code exposed as an A2A-compatible agent via a2a-bridge.",
    version: config.version ?? "0.0.1",
    url: config.url,
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", ...(config.extraOutputModes ?? [])],
    skills,
    securitySchemes: {
      bearer: {
        type: "http",
        scheme: "bearer",
        description: "Bearer token required on the JSON-RPC endpoint.",
      },
    },
    security: [{ bearer: [] }],
  };
}
