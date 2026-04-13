import type { JsonRpcId } from "@daemon/inbound/a2a-http/jsonrpc";
import type { Task, TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";
import type { ClaudeCodeGateway } from "@daemon/inbound/a2a-http/claude-code-gateway";

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
  /**
   * Registry this stream registers against. When supplied, the handler
   * creates the task on start, mirrors status-updates into it, and
   * listens for `cancel` events so `tasks/cancel` can terminate the
   * stream with a final status-update(canceled).
   */
  registry?: TaskRegistry;
}

/** Build an SSE `Response` for a single `message/stream` request. */
export function handleMessageStream(opts: HandleMessageStreamOptions): Response {
  const makeId = opts.idFactory ?? (() => crypto.randomUUID());
  const taskId = makeId();
  const contextId = opts.params.message.contextId ?? makeId();
  const userText = extractText(opts.params.message);

  const encoder = new TextEncoder();

  const registry = opts.registry;
  const initialTask: Task = {
    id: taskId,
    contextId,
    kind: "task",
    status: { state: "submitted" },
  };
  registry?.create(initialTask);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let terminated = false;
      const write = (result: unknown) => {
        if (closed) return;
        const frame = `data: ${JSON.stringify({ jsonrpc: "2.0", id: opts.rpcId, result })}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      // 1. Initial task event.
      write(initialTask);

      const emit: StreamEmitter = (event) => {
        if (event.kind === "status-update") {
          const status = event.message
            ? { state: event.state, message: event.message }
            : { state: event.state };
          registry?.updateStatus(taskId, status);
          write({
            kind: "status-update",
            taskId,
            contextId,
            status,
            final: event.final ?? false,
          });
          if (event.final) {
            terminated = true;
          }
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

      const onRegistryCancel = (canceledId: string) => {
        if (canceledId !== taskId || terminated) return;
        emit({
          kind: "status-update",
          state: "canceled",
          final: true,
          message: {
            kind: "message",
            messageId: makeId(),
            role: "agent",
            parts: [{ kind: "text", text: "Task canceled by client." }],
          },
        });
        closed = true;
        try {
          controller.close();
        } catch {}
      };
      registry?.on("cancel", onRegistryCancel);

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
          registry?.off("cancel", onRegistryCancel);
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

/**
 * Build an executor that forwards the user's text into the daemon's
 * single active Claude Code room via a `ClaudeCodeGateway`. Each CC
 * reply chunk becomes an `artifact-update(append: true)` SSE event;
 * turn completion emits the terminal `status-update(completed)`.
 *
 * Replaces the echo executor once a gateway is wired. The gateway
 * abstraction keeps the dep-cruiser boundary honest: inbound does not
 * import Codex internals, it only calls `startTurn`.
 */
export interface ClaudeCodeExecutorOptions {
  gateway: ClaudeCodeGateway;
  /** Stable artifact id used for the streamed reply. */
  artifactId?: string;
  /** Deterministic id source for the terminal message; mainly for tests. */
  idFactory?: () => string;
}

export function createClaudeCodeExecutor(
  opts: ClaudeCodeExecutorOptions,
): MessageStreamExecutor {
  const makeId = opts.idFactory ?? (() => crypto.randomUUID());
  const artifactId = opts.artifactId ?? "claude-code-reply";

  return ({ userText, emit }) =>
    new Promise<void>((resolve, reject) => {
      emit({ kind: "status-update", state: "working" });
      const turn = opts.gateway.startTurn(userText);

      const onChunk = (text: string) => {
        if (text.length === 0) return;
        emit({
          kind: "artifact-update",
          artifactId,
          text,
          append: true,
        });
      };

      const cleanup = () => {
        turn.off("chunk", onChunk);
        turn.off("complete", onComplete);
        turn.off("error", onError);
      };

      const onComplete = () => {
        cleanup();
        emit({
          kind: "status-update",
          state: "completed",
          final: true,
          message: {
            kind: "message",
            messageId: makeId(),
            role: "agent",
            parts: [{ kind: "text", text: "Turn complete." }],
          },
        });
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      turn.on("chunk", onChunk);
      turn.on("complete", onComplete);
      turn.on("error", onError);
    });
}

function extractText(msg: A2aMessage): string {
  return (msg.parts ?? [])
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("");
}
