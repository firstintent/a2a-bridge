import type { JsonRpcId } from "@daemon/inbound/a2a-http/jsonrpc";

/**
 * `message/stream` SSE handler.
 *
 * Produces a `text/event-stream` response that emits, in order:
 *   1. a `task` event — fresh id / contextId
 *   2. a `status-update` with `state: "working"`
 *   3. an `artifact-update` containing the caller's text
 *   4. a terminal `status-update` with `final: true`, `state: "completed"`,
 *      and a non-empty `status.message`
 *
 * Steps 2–4 are supplied by the pluggable `executor` callback. The
 * default `createEchoExecutor()` produces a no-CC echo — useful for
 * smoke tests and as the fallback when no peer is configured.
 *
 * The transport is A2A-SSE: each SSE frame carries one JSON-RPC 2.0
 * response whose `result` is a Task or an event. The JSON-RPC `id` is
 * forwarded from the request so the client can correlate frames.
 */

export interface TextPart {
  kind: "text";
  text: string;
}

export type MessagePart = TextPart;

export interface A2aMessage {
  kind?: "message";
  messageId?: string;
  role?: "user" | "agent";
  parts: MessagePart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageStreamParams {
  message: A2aMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    blocking?: boolean;
  };
}

export type StreamEmitter = (event: StreamEvent) => void;

export type MessageStreamExecutor = (ctx: {
  taskId: string;
  contextId: string;
  userText: string;
  emit: StreamEmitter;
}) => Promise<void> | void;

export type StreamEvent =
  | {
      kind: "status-update";
      state: string;
      final?: boolean;
      message?: A2aMessage;
    }
  | {
      kind: "artifact-update";
      artifactId: string;
      text: string;
      append?: boolean;
      lastChunk?: boolean;
    };

export interface HandleMessageStreamOptions {
  /** JSON-RPC id from the inbound request; forwarded on every SSE frame. */
  rpcId: JsonRpcId;
  /** Parsed `params` object of the JSON-RPC request. */
  params: MessageStreamParams;
  /** Executor that drives the stream after the initial `task` event. */
  executor: MessageStreamExecutor;
  /** Deterministic id source for tests; defaults to `crypto.randomUUID`. */
  idFactory?: () => string;
}

/** Build an SSE `Response` for a single `message/stream` request. */
export function handleMessageStream(opts: HandleMessageStreamOptions): Response {
  const makeId = opts.idFactory ?? (() => crypto.randomUUID());
  const taskId = makeId();
  const contextId = opts.params.message.contextId ?? makeId();
  const userText = extractText(opts.params.message);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (result: unknown) => {
        if (closed) return;
        const frame = `data: ${JSON.stringify({ jsonrpc: "2.0", id: opts.rpcId, result })}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      // 1. Initial task event.
      write({
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "submitted" },
      });

      const emit: StreamEmitter = (event) => {
        if (event.kind === "status-update") {
          write({
            kind: "status-update",
            taskId,
            contextId,
            status: event.message
              ? { state: event.state, message: event.message }
              : { state: event.state },
            final: event.final ?? false,
          });
        } else {
          write({
            kind: "artifact-update",
            taskId,
            contextId,
            artifact: {
              artifactId: event.artifactId,
              parts: [{ kind: "text", text: event.text }],
            },
            append: event.append ?? false,
            lastChunk: event.lastChunk ?? false,
          });
        }
      };

      const run = async () => {
        try {
          await opts.executor({ taskId, contextId, userText, emit });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          emit({
            kind: "status-update",
            state: "failed",
            final: true,
            message: {
              kind: "message",
              messageId: makeId(),
              role: "agent",
              parts: [{ kind: "text", text: `Stream failed: ${reason}` }],
            },
          });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      };

      void run();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * Default executor used when no peer is wired — produces a synchronous
 * echo that lets clients smoke-test the four-event envelope.
 */
export function createEchoExecutor(
  options: { idFactory?: () => string } = {},
): MessageStreamExecutor {
  const makeId = options.idFactory ?? (() => crypto.randomUUID());
  return ({ userText, emit }) => {
    emit({ kind: "status-update", state: "working" });
    emit({
      kind: "artifact-update",
      artifactId: "echo-output",
      text: userText,
      append: false,
      lastChunk: true,
    });
    emit({
      kind: "status-update",
      state: "completed",
      final: true,
      message: {
        kind: "message",
        messageId: makeId(),
        role: "agent",
        parts: [{ kind: "text", text: `Echo complete: ${userText}` }],
      },
    });
  };
}

function extractText(msg: A2aMessage): string {
  return (msg.parts ?? [])
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("");
}
