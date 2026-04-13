/**
 * ACP-over-stdio inbound service.
 *
 * P5.3 lands the handshake: `initialize` returns the agent's protocol
 * version and minimum capabilities, `newSession` mints a session id
 * from the request's cwd (so the same cwd reuses its session id on a
 * reconnect). Prompt + cancel are stubbed pending P5.4 / P5.5.
 */

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import type { IInboundService } from "@daemon/inbound/inbound-service";
import {
  buildAcpStream,
  type AcpStdioPair,
} from "@daemon/inbound/acp/connection";

export interface AcpInboundConfig {
  /**
   * stdio pair the ACP server reads from / writes to. May also be
   * passed directly to `start(stdio)` so P5.6's `a2a-bridge acp` CLI
   * can inject `Bun.stdin.stream()` / a stdout writer at boot.
   */
  stdio?: AcpStdioPair;
}

type AgentFactory = (conn: AgentSideConnection) => Agent;

const NOT_IMPLEMENTED = (method: string) =>
  new Error(
    `AcpInboundService: ${method} not implemented yet — wired in later P5 tasks`,
  );

export class AcpInboundService implements IInboundService {
  readonly kind = "acp-stdio";

  private readonly defaultStdio?: AcpStdioPair;
  private connection: AgentSideConnection | null = null;
  private activeSessions = new Map<string, { cwd: string }>();
  private readonly makeSessionId: () => string;

  constructor(config: AcpInboundConfig) {
    this.defaultStdio = config.stdio;
    this.makeSessionId = () => crypto.randomUUID();
  }

  /**
   * Open an `AgentSideConnection` over the supplied stdio pair. When
   * omitted, falls back to the pair passed at construction time.
   */
  async start(stdio?: AcpStdioPair): Promise<void> {
    const pair = stdio ?? this.defaultStdio;
    if (!pair) {
      throw new Error(
        "AcpInboundService.start: no stdio pair supplied via config or argument",
      );
    }
    if (this.connection) {
      throw new Error("AcpInboundService.start: already started");
    }
    const stream = buildAcpStream(pair);
    this.connection = new AgentSideConnection(this.buildAgent.bind(this), stream);
  }

  async stop(): Promise<void> {
    // `AgentSideConnection` has no explicit close method in 0.18 — the
    // connection terminates when its underlying stream is cancelled by
    // the caller (Bun shuts stdin down on process exit). Just drop our
    // handles so a re-`start()` works.
    this.connection = null;
    this.activeSessions.clear();
  }

  /**
   * Returns the set of session ids this service has minted so far.
   * Mainly for tests; production callers route through newSession
   * responses instead.
   */
  sessionCount(): number {
    return this.activeSessions.size;
  }

  private buildAgent: AgentFactory = () => {
    const self = this;
    const agent: Agent = {
      async initialize(params: InitializeRequest): Promise<InitializeResponse> {
        // Echo the client's version if it matches ours; otherwise fall
        // back to our latest. A newer client sending a version we
        // support still gets a live handshake on our version.
        const negotiated =
          params.protocolVersion === PROTOCOL_VERSION
            ? params.protocolVersion
            : PROTOCOL_VERSION;
        return {
          protocolVersion: negotiated,
          agentInfo: { name: "a2a-bridge", version: "0.0.1" },
          // Minimum capabilities — no tool-calling or resume surfaces
          // advertised until later tasks fill them in.
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
        };
      },
      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        const sessionId = self.makeSessionId();
        self.activeSessions.set(sessionId, { cwd: params.cwd });
        return { sessionId };
      },
      async authenticate(_: AuthenticateRequest): Promise<AuthenticateResponse> {
        throw NOT_IMPLEMENTED("authenticate");
      },
      async prompt(_: PromptRequest): Promise<PromptResponse> {
        throw NOT_IMPLEMENTED("prompt");
      },
      async cancel(_: CancelNotification): Promise<void> {
        throw NOT_IMPLEMENTED("cancel");
      },
    };
    return agent;
  };
}
