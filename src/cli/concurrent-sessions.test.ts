import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { A2AClient } from "@a2a-js/sdk/client";
import {
  startA2AServer,
  type A2aServerHandle,
} from "@daemon/inbound/a2a-http/server";
import { Room } from "@daemon/rooms/room";
import { RoomRouter } from "@daemon/rooms/room-router";
import type { RoomId } from "@daemon/rooms/room-id";
import { TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";
import type { MessageStreamExecutor } from "@daemon/inbound/a2a-http/handlers/message-stream";

/**
 * Concurrent-session integration test (P4.10).
 *
 * Drives two `@a2a-js/sdk` clients against the same `startA2AServer`
 * with distinct `contextId`s in parallel. Each `contextId` routes to
 * a different Room whose per-room stub gateway emits a distinguishing
 * marker. The test asserts:
 *   - Each client only observes its own room's artifact text (no
 *     cross-leakage between SSE streams).
 *   - `tasks/get` on each client's task id returns that client's
 *     terminal state; the other client's task is isolated.
 */

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardown.length) {
    try {
      await teardown.pop()!();
    } catch {}
  }
});

function randomPort(): number {
  return 45000 + Math.floor(Math.random() * 10000);
}
function baseUrl(port: number): string {
  return `http://localhost:${port}`;
}
function track<T extends { shutdown(): Promise<void> }>(handle: T): T {
  teardown.push(() => handle.shutdown());
  return handle;
}

class StubTurn extends EventEmitter implements ClaudeCodeTurn {
  cancel(): void {}
}

class StubGateway implements ClaudeCodeGateway {
  constructor(private readonly label: string) {}
  startTurn(_userText: string): ClaudeCodeTurn {
    const turn = new StubTurn();
    // Emit the room's label on next tick so the SSE handler has
    // registered its `chunk` listener before we fire.
    setImmediate(() => {
      turn.emit("chunk", this.label);
      turn.emit("complete");
    });
    return turn;
  }
}

describe("concurrent sessions — SDK integration (P4.10)", () => {
  test("two contextIds run in parallel without event or task leakage", async () => {
    const sharedRegistry = new TaskRegistry();
    const router = new RoomRouter((id: RoomId) => {
      const gateway = new StubGateway(`from-${id}`);
      return new Room({ id, gateway, registry: sharedRegistry });
    });

    const executorFactory = (
      gateway: ClaudeCodeGateway,
    ): MessageStreamExecutor =>
      ({ userText, emit }) =>
        new Promise<void>((resolve) => {
          emit({ kind: "status-update", state: "working" });
          const turn = gateway.startTurn(userText);
          turn.on("chunk", (text) => {
            emit({
              kind: "artifact-update",
              artifactId: "out",
              text,
              append: true,
            });
          });
          turn.on("complete", () => {
            emit({
              kind: "status-update",
              state: "completed",
              final: true,
              message: {
                kind: "message",
                messageId: "m",
                role: "agent",
                parts: [{ kind: "text", text: "done" }],
              },
            });
            resolve();
          });
        });

    const port = randomPort();
    const bearer = "ctx-isolation-token";
    const server = track(
      await startA2AServer({
        port,
        logger: () => {},
        bearerToken: bearer,
        publicAgentCard: true,
        agentCard: { url: `${baseUrl(port)}/a2a` },
        registry: sharedRegistry,
        roomRouter: router,
        executorFactory,
      }),
    );

    const authedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      return fetch(input, { ...init, headers });
    }) as unknown as typeof fetch;

    const makeClient = () =>
      A2AClient.fromCardUrl(`${baseUrl(server.port)}/.well-known/agent-card.json`, {
        fetchImpl: authedFetch,
      });

    const [clientAlpha, clientBeta] = await Promise.all([makeClient(), makeClient()]);

    const runStream = async (
      client: A2AClient,
      contextId: string,
    ): Promise<{ taskId: string; artifactText: string; state?: string }> => {
      const stream = client.sendMessageStream({
        message: {
          kind: "message",
          messageId: `msg-${contextId}`,
          role: "user",
          contextId,
          parts: [{ kind: "text", text: `hello from ${contextId}` }],
        },
      });
      let taskId = "";
      let artifactText = "";
      let state: string | undefined;
      for await (const event of stream) {
        const kind = (event as { kind?: string }).kind;
        if (kind === "task") {
          taskId = (event as { id: string }).id;
        } else if (kind === "artifact-update") {
          const parts = (event as { artifact: { parts: Array<{ kind: string; text?: string }> } })
            .artifact.parts;
          for (const p of parts) {
            if (p.kind === "text" && p.text) artifactText += p.text;
          }
        } else if (kind === "status-update") {
          const e = event as { final?: boolean; status?: { state?: string } };
          if (e.final) state = e.status?.state;
        }
      }
      return { taskId, artifactText, state };
    };

    const [alpha, beta] = await Promise.all([
      runStream(clientAlpha, "ctx-alpha"),
      runStream(clientBeta, "ctx-beta"),
    ]);

    expect(alpha.artifactText).toBe("from-ctx-alpha");
    expect(beta.artifactText).toBe("from-ctx-beta");
    expect(alpha.state).toBe("completed");
    expect(beta.state).toBe("completed");
    expect(alpha.taskId).not.toBe(beta.taskId);

    // Router grew to two rooms; each client's task only appears in its
    // own room's history.
    expect(router.size).toBe(2);
    const alphaTasks = sharedRegistry
      .listByRoom("ctx-alpha" as RoomId)
      .map((t) => t.id);
    const betaTasks = sharedRegistry
      .listByRoom("ctx-beta" as RoomId)
      .map((t) => t.id);
    expect(alphaTasks).toContain(alpha.taskId);
    expect(betaTasks).toContain(beta.taskId);
    expect(alphaTasks).not.toContain(beta.taskId);
    expect(betaTasks).not.toContain(alpha.taskId);

    // Cross-check: looking up the *other* client's task id in a room
    // that isn't this client's returns an empty result — the two task
    // histories are fully partitioned.
    expect(sharedRegistry.listByRoom("ctx-alpha" as RoomId).map((t) => t.id)).toEqual([
      alpha.taskId,
    ]);
    expect(sharedRegistry.listByRoom("ctx-beta" as RoomId).map((t) => t.id)).toEqual([
      beta.taskId,
    ]);
  });
});
