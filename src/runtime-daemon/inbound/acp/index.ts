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
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionId,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { IInboundService } from "@daemon/inbound/inbound-service";
import type { ClaudeCodeGateway } from "@daemon/inbound/a2a-http/claude-code-gateway";
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
  /**
   * Gateway the `prompt` handler forwards turns into. When absent, a
   * prompt call returns `stopReason: "refusal"` with an explanatory
   * message — keeps P5.2 smoke tests usable before gateway wiring.
   */
  gateway?: ClaudeCodeGateway;
}

type AgentFactory = (conn: AgentSideConnection) => Agent;

const NOT_IMPLEMENTED = (method: string) =>
  new Error(
    `AcpInboundService: ${method} not implemented yet — wired in later P5 tasks`,
  );

export class AcpInboundService implements IInboundService {
  readonly kind = "acp-stdio";

  private readonly defaultStdio?: AcpStdioPair;
  private readonly gateway?: ClaudeCodeGateway;
  private connection: AgentSideConnection | null = null;
  private activeSessions = new Map<string, { cwd: string }>();
  private readonly makeSessionId: () => string;

  constructor(config: AcpInboundConfig) {
    this.defaultStdio = config.stdio;
    this.gateway = config.gateway;
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

  private buildAgent: AgentFactory = (conn) => {
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
      async prompt(params: PromptRequest): Promise<PromptResponse> {
        return runPromptTurn({
          conn,
          gateway: self.gateway,
          sessionId: params.sessionId,
          userText: extractUserText(params.prompt),
        });
      },
      async cancel(_: CancelNotification): Promise<void> {
        throw NOT_IMPLEMENTED("cancel");
      },
    };
    return agent;
  };
}

function extractUserText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

interface RunPromptArgs {
  conn: AgentSideConnection;
  gateway: ClaudeCodeGateway | undefined;
  sessionId: SessionId;
  userText: string;
}

/**
 * Drive one ACP `prompt` turn: spawn a gateway turn, rebroadcast each
 * chunk as an `agent_message_chunk` `session/update`, and resolve with
 * the terminal stop reason. Extracted out of the Agent factory so the
 * event-listener closure doesn't have to juggle `this` references.
 */
function runPromptTurn(args: RunPromptArgs): Promise<PromptResponse> {
  const { conn, gateway, sessionId, userText } = args;

  if (!gateway) {
    // No gateway wired — surface a refusal so the client gets a
    // deterministic response instead of the SDK timing out waiting.
    return (async () => {
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "a2a-bridge ACP inbound: no ClaudeCodeGateway configured; refusing prompt.",
          },
        },
      });
      return { stopReason: "refusal" as StopReason };
    })();
  }

  return new Promise<PromptResponse>((resolve) => {
    const turn = gateway.startTurn(userText);
    let settled = false;

    const finish = (stopReason: StopReason) => {
      if (settled) return;
      settled = true;
      turn.off("chunk", onChunk);
      turn.off("complete", onComplete);
      turn.off("error", onError);
      resolve({ stopReason });
    };

    const onChunk = (text: string) => {
      if (!text) return;
      void conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    };

    const onComplete = () => finish("end_turn");

    const onError = (err: Error) => {
      void conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `ClaudeCodeGateway error: ${err.message}`,
          },
        },
      });
      finish("refusal");
    };

    turn.on("chunk", onChunk);
    turn.on("complete", onComplete);
    turn.on("error", onError);
  });
}
