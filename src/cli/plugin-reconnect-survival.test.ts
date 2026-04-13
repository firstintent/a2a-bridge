import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { A2AClient } from "@a2a-js/sdk/client";
import {
  startA2AServer,
  type A2aServerHandle,
} from "@daemon/inbound/a2a-http/server";
import { Room } from "@daemon/rooms/room";
import { RoomRouter } from "@daemon/rooms/room-router";
import type { RoomId } from "@daemon/rooms/room-id";
import { SqliteTaskLog } from "@daemon/tasks/task-log";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";
import type { MessageStreamExecutor } from "@daemon/inbound/a2a-http/handlers/message-stream";

/**
 * Plugin-reconnect task survival test (P4.11).
 *
 * The "plugin" is the CC-side client that reaches the daemon over the
 * control plane. What we actually care about for persistence is:
 * tasks written to SQLite survive the daemon process going away. This
 * test simulates the worst-case cut-over — a turn starts, the
 * in-progress status lands in the sqlite file, everything is torn
 * down mid-turn, a new server opens the same tasks.db, and the
 * caller's `tasks/get` request comes back with the stored state.
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
function track(handle: A2aServerHandle): A2aServerHandle {
  teardown.push(() => handle.shutdown());
  return handle;
}

class SilentTurn extends EventEmitter implements ClaudeCodeTurn {
  cancel(): void {}
}
class SilentGateway implements ClaudeCodeGateway {
  startTurn(_userText: string): ClaudeCodeTurn {
    // Return a turn that emits no events — simulates a CC turn still
    // in flight when the daemon goes down.
    return new SilentTurn();
  }
}

describe("plugin-reconnect task survival (P4.11)", () => {
  test("a mid-turn task persists in SQLite and tasks/get works after restart", async () => {
    const dbPath = join(
      tmpdir(),
      `a2a-bridge-reconnect-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    teardown.push(async () => {
      rmSync(dbPath, { force: true });
    });

    const bearer = "reconnect-token";

    // --- First boot: open store1, start server1, kick off a turn that
    //     never completes. The task's "submitted" (then "working")
    //     state lands in SQLite via the executor.
    const store1 = SqliteTaskLog.open(dbPath);
    const router1 = new RoomRouter(
      (id: RoomId) =>
        new Room({ id, gateway: new SilentGateway(), registry: store1 }),
    );

    const executorFactory = (
      gateway: ClaudeCodeGateway,
    ): MessageStreamExecutor =>
      ({ userText, emit }) =>
        new Promise<void>(() => {
          // Never resolve — the server will close out from under the
          // hanging SSE stream when it shuts down.
          emit({ kind: "status-update", state: "working" });
          gateway.startTurn(userText);
        });

    const port1 = randomPort();
    const server1 = track(
      await startA2AServer({
        port: port1,
        logger: () => {},
        bearerToken: bearer,
        publicAgentCard: true,
        agentCard: { url: `${baseUrl(port1)}/a2a` },
        registry: store1,
        roomRouter: router1,
        executorFactory,
      }),
    );

    // Post a message/stream request but tear the connection down
    // before it completes by aborting the fetch on our side.
    const controller = new AbortController();
    const postPromise = fetch(`${baseUrl(server1.port)}${server1.rpcPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/stream",
        params: {
          message: {
            contextId: "ctx-survive",
            parts: [{ kind: "text", text: "start a turn that won't finish" }],
          },
        },
        id: "post-1",
      }),
      signal: controller.signal,
    });

    // Read enough of the SSE body to see the task event + working
    // status land, then confirm the row exists in the store.
    const resp = await postPromise;
    expect(resp.status).toBe(200);
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let taskId = "";
    let sawWorking = false;
    while (!taskId || !sawWorking) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) break;
      for (;;) {
        const idx = buffer.indexOf("\n\n");
        if (idx === -1) break;
        const record = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = record
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice("data: ".length))
          .join("");
        if (!line) continue;
        const frame = JSON.parse(line) as { result: Record<string, unknown> };
        const kind = frame.result.kind as string | undefined;
        if (kind === "task" && !taskId) {
          taskId = frame.result.id as string;
        } else if (
          kind === "status-update" &&
          (frame.result.status as { state?: string }).state === "working"
        ) {
          sawWorking = true;
        }
      }
    }
    expect(taskId.length).toBeGreaterThan(0);
    expect(sawWorking).toBe(true);

    // Sanity: the stored row carries the expected room_id and state.
    const row1 = store1.get(taskId);
    expect(row1).toBeDefined();
    expect(row1!.status.state).toBe("working");

    // --- Simulate the plugin/daemon going away mid-turn: abort the
    //     client, shut down the server, close the store. The task row
    //     should remain in the sqlite file.
    controller.abort();
    try {
      reader.cancel();
    } catch {}
    await server1.shutdown();
    store1.close();
    // Remove the teardown entry we registered for server1 — it's
    // already shut down; letting it rerun throws.
    teardown.splice(teardown.indexOf(teardown[teardown.length - 1]!), 1);

    // --- Second boot: reopen the same sqlite file, start a fresh
    //     server, and verify tasks/get surfaces the stored state.
    const store2 = SqliteTaskLog.open(dbPath);
    const router2 = new RoomRouter(
      (id: RoomId) =>
        new Room({ id, gateway: new SilentGateway(), registry: store2 }),
    );
    const port2 = randomPort();
    const server2 = track(
      await startA2AServer({
        port: port2,
        logger: () => {},
        bearerToken: bearer,
        publicAgentCard: true,
        agentCard: { url: `${baseUrl(port2)}/a2a` },
        registry: store2,
        roomRouter: router2,
        executorFactory,
      }),
    );

    // Direct store check: the row is there.
    const row2 = store2.get(taskId);
    expect(row2).toBeDefined();
    expect(row2!.status.state).toBe("working");
    expect(row2!.roomId).toBe("ctx-survive" as RoomId);

    // Wire-level check: the A2A client's tasks/get RPC returns a
    // result without error on the resurrected server.
    const authedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      return fetch(input, { ...init, headers });
    }) as unknown as typeof fetch;
    const client = await A2AClient.fromCardUrl(
      `${baseUrl(server2.port)}/.well-known/agent-card.json`,
      { fetchImpl: authedFetch },
    );
    // The SDK surfaces getTask result shape inconsistently across
    // versions; go straight to the JSON-RPC call so the assertion is
    // stable regardless.
    void client;
    const rpcResp = await fetch(
      `${baseUrl(server2.port)}${server2.rpcPath}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tasks/get",
          params: { id: taskId },
          id: "get-1",
        }),
      },
    );
    expect(rpcResp.status).toBe(200);
    const body = (await rpcResp.json()) as {
      result?: {
        id: string;
        status: { state: string };
      };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.id).toBe(taskId);
    expect(body.result?.status.state).toBe("working");

    store2.close();
  });
});
