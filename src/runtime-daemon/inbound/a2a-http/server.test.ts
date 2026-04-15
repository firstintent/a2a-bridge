import { describe, test, expect, afterEach } from "bun:test";
import {
  parseContextRoutes,
  startA2AServer,
  type A2aServerHandle,
} from "@daemon/inbound/a2a-http/server";
import { Room } from "@daemon/rooms/room";
import { RoomRouter } from "@daemon/rooms/room-router";
import type { RoomId } from "@daemon/rooms/room-id";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";
import { EventEmitter } from "node:events";
import { TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";
import type { MessageStreamExecutor } from "@daemon/inbound/a2a-http/handlers/message-stream";

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

function cardConfig(port: number) {
  return { url: `http://localhost:${port}/a2a` };
}

type SilentConfig = {
  port: number;
  logger: () => void;
  agentCard: { url: string };
  bearerToken: string;
  publicAgentCard: boolean;
};

function silent(port: number, overrides: Partial<SilentConfig> = {}): SilentConfig {
  return {
    port,
    logger: () => {},
    agentCard: cardConfig(port),
    bearerToken: "test-token",
    publicAgentCard: true,
    ...overrides,
  };
}

function track(handle: A2aServerHandle) {
  teardown.push(() => handle.shutdown());
  return handle;
}

describe("startA2AServer", () => {
  test("GET /healthz returns 200 ok", async () => {
    const server = track(await startA2AServer(silent(randomPort())));
    const resp = await fetch(`http://localhost:${server.port}/healthz`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });

  test("unknown paths return 404", async () => {
    const server = track(await startA2AServer(silent(randomPort())));
    const resp = await fetch(`http://localhost:${server.port}/nope`);
    expect(resp.status).toBe(404);
  });

  test("each request is emitted through the logger", async () => {
    const lines: string[] = [];
    const port = randomPort();
    const server = track(
      await startA2AServer({
        port,
        logger: (msg) => {
          lines.push(msg);
        },
        agentCard: cardConfig(port),
        bearerToken: "t",
        publicAgentCard: true,
      }),
    );

    await fetch(`http://localhost:${server.port}/healthz`);
    await fetch(`http://localhost:${server.port}/nope`);

    const requestLines = lines.filter((line) => line.includes("GET /"));
    expect(requestLines).toEqual(["GET /healthz", "GET /nope"]);
  });

  test("shutdown() releases the port", async () => {
    const port = randomPort();
    const server = await startA2AServer(silent(port));
    await server.shutdown();

    const replacement = track(await startA2AServer(silent(port)));
    expect(replacement.port).toBe(port);
  });

  test("GET /.well-known/agent-card.json returns the built card as JSON when public", async () => {
    const port = randomPort();
    const server = track(
      await startA2AServer({
        port,
        logger: () => {},
        agentCard: { url: `http://localhost:${port}/a2a`, version: "1.2.3" },
        bearerToken: "t",
        publicAgentCard: true,
      }),
    );

    const resp = await fetch(`http://localhost:${server.port}/.well-known/agent-card.json`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/^application\/json/);

    const body = (await resp.json()) as {
      protocolVersion: string;
      url: string;
      version: string;
      capabilities: { streaming: boolean };
      skills: unknown[];
      securitySchemes: Record<string, { type: string; scheme: string }>;
    };

    expect(body.protocolVersion).toBe("0.3.0");
    expect(body.version).toBe("1.2.3");
    expect(body.capabilities.streaming).toBe(true);
    expect(body.skills.length).toBeGreaterThanOrEqual(1);
    const [[, scheme]] = Object.entries(body.securitySchemes);
    expect(scheme!.type).toBe("http");
    expect(scheme!.scheme).toBe("bearer");
  });

  test("agent-card requires auth when publicAgentCard is false", async () => {
    const port = randomPort();
    const server = track(
      await startA2AServer(silent(port, { publicAgentCard: false, bearerToken: "secret" })),
    );

    const denied = await fetch(`http://localhost:${server.port}/.well-known/agent-card.json`);
    expect(denied.status).toBe(401);

    const ok = await fetch(`http://localhost:${server.port}/.well-known/agent-card.json`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
  });

  test("POST rpcPath with tasks/get returns a -32001 error for unknown ids", async () => {
    const port = randomPort();
    const server = track(await startA2AServer(silent(port, { bearerToken: "tok" })));

    const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: "nope" },
        id: 1,
      }),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });

  test("POST rpcPath rejects missing bearer token with 401", async () => {
    const port = randomPort();
    const server = track(await startA2AServer(silent(port, { bearerToken: "tok" })));
    const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tasks/get", id: 1 }),
    });
    expect(resp.status).toBe(401);
  });

  test("POST rpcPath with message/stream returns text/event-stream (echo executor)", async () => {
    const port = randomPort();
    const server = track(await startA2AServer(silent(port, { bearerToken: "tok" })));

    const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/stream",
        params: { message: { parts: [{ kind: "text", text: "ping" }] } },
        id: "m1",
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const text = await resp.text();
    const frames = text
      .split("\n\n")
      .filter((r) => r.startsWith("data: "))
      .map((r) => JSON.parse(r.slice("data: ".length)));
    expect(frames.length).toBe(4);
    const last = frames[3].result as { final: boolean; status: { state: string } };
    expect(last.final).toBe(true);
    expect(last.status.state).toBe("completed");
  });

  test("routes through RoomRouter: two contextIds hit distinct per-room gateways", async () => {
    // Each room's gateway emits text identifying the room it belongs to.
    // Two concurrent message/stream requests with different contextIds
    // must each come back with their own room's label, never the other's.
    const gatewayByRoom = new Map<string, StubGateway>();
    const roomFactory = (id: RoomId) => {
      const gateway = new StubGateway(`from-${id}`);
      gatewayByRoom.set(id, gateway);
      return new Room({ id, gateway, registry: new TaskRegistry() });
    };
    const router = new RoomRouter(roomFactory);

    const port = randomPort();
    const server = track(
      await startA2AServer({
        port,
        logger: () => {},
        agentCard: cardConfig(port),
        bearerToken: "tok",
        publicAgentCard: true,
        roomRouter: router,
        executorFactory: (gateway): MessageStreamExecutor => ({
          taskId,
          contextId,
          userText,
          emit,
        }) =>
          new Promise<void>((resolve) => {
            const turn = gateway.startTurn(userText);
            void taskId;
            void contextId;
            emit({ kind: "status-update", state: "working" });
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
          }),
      }),
    );

    const postMessage = async (contextId: string) => {
      const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "message/stream",
          params: {
            message: { contextId, parts: [{ kind: "text", text: "hi" }] },
          },
          id: contextId,
        }),
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      const frames = text
        .split("\n\n")
        .filter((r) => r.startsWith("data: "))
        .map((r) => JSON.parse(r.slice("data: ".length)));
      const joinedArtifactText = frames
        .filter((f) => f.result.kind === "artifact-update")
        .map(
          (f) =>
            (f.result.artifact.parts[0] as { text: string }).text,
        )
        .join("");
      return joinedArtifactText;
    };

    // Kick both rooms off concurrently with distinct contextIds, then
    // let each gateway complete its turn.
    const p1 = postMessage("ctx-alpha");
    const p2 = postMessage("ctx-beta");
    await new Promise((r) => setTimeout(r, 20));
    gatewayByRoom.get("ctx-alpha")!.pushAndComplete();
    gatewayByRoom.get("ctx-beta")!.pushAndComplete();
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe("from-ctx-alpha");
    expect(b).toBe("from-ctx-beta");
    expect(router.size).toBe(2);
  });

  test("P10.7: contextRoutes maps contextId to TargetId; unmapped falls back to claude:default", async () => {
    // Three inbound contextIds:
    //  - `ctx-alice` is mapped to `claude:alice`  → routes to its Room
    //  - `ctx-bob` is mapped to `claude:bob`      → routes to its Room
    //  - `ctx-stranger` has no mapping            → falls back to `claude:default`
    // Each Room's stub gateway emits a label derived from its TargetId,
    // proving the router keyed on the right entry.
    const gatewayByRoom = new Map<string, StubGateway>();
    const roomFactory = (id: RoomId) => {
      const gateway = new StubGateway(`room-${id}`);
      gatewayByRoom.set(id, gateway);
      return new Room({ id, gateway, registry: new TaskRegistry() });
    };
    const router = new RoomRouter(roomFactory);

    const port = randomPort();
    const server = track(
      await startA2AServer({
        port,
        logger: () => {},
        agentCard: cardConfig(port),
        bearerToken: "tok",
        publicAgentCard: true,
        roomRouter: router,
        contextRoutes: {
          "ctx-alice": "claude:alice",
          "ctx-bob": "claude:bob",
        },
        executorFactory: (gateway): MessageStreamExecutor => ({
          taskId,
          contextId,
          userText,
          emit,
        }) =>
          new Promise<void>((resolve) => {
            const turn = gateway.startTurn(userText);
            void taskId;
            void contextId;
            emit({ kind: "status-update", state: "working" });
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
          }),
      }),
    );

    const postMessage = async (contextId: string) => {
      const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "message/stream",
          params: {
            message: { contextId, parts: [{ kind: "text", text: "hi" }] },
          },
          id: contextId,
        }),
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      const frames = text
        .split("\n\n")
        .filter((r) => r.startsWith("data: "))
        .map((r) => JSON.parse(r.slice("data: ".length)));
      const joined = frames
        .filter((f) => f.result.kind === "artifact-update")
        .map((f) => (f.result.artifact.parts[0] as { text: string }).text)
        .join("");
      return joined;
    };

    const pAlice = postMessage("ctx-alice");
    const pBob = postMessage("ctx-bob");
    const pStranger = postMessage("ctx-stranger");
    await new Promise((r) => setTimeout(r, 20));
    gatewayByRoom.get("claude:alice")!.pushAndComplete();
    gatewayByRoom.get("claude:bob")!.pushAndComplete();
    gatewayByRoom.get("claude:default")!.pushAndComplete();
    const [a, b, d] = await Promise.all([pAlice, pBob, pStranger]);

    expect(a).toBe("room-claude:alice");
    expect(b).toBe("room-claude:bob");
    expect(d).toBe("room-claude:default");
    // Three distinct Rooms were minted — one per resolved TargetId.
    // Notably "ctx-stranger" did NOT mint its own Room (which it
    // would under v0.1 deriveRoomId).
    expect(router.size).toBe(3);
    expect(router.get("claude:alice" as unknown as RoomId)).toBeDefined();
    expect(router.get("claude:default" as unknown as RoomId)).toBeDefined();
    expect(router.get("ctx-stranger" as unknown as RoomId)).toBeUndefined();
  });

  test("P10.7: contextRoutes rejects a malformed TargetId at startup", async () => {
    const router = new RoomRouter((id: RoomId) => {
      const gateway = new StubGateway(`room-${id}`);
      return new Room({ id, gateway, registry: new TaskRegistry() });
    });
    const port = randomPort();
    await expect(
      startA2AServer({
        port,
        logger: () => {},
        agentCard: cardConfig(port),
        bearerToken: "tok",
        publicAgentCard: true,
        roomRouter: router,
        contextRoutes: { "ctx-bad": "NotAValidTarget" },
        executorFactory: () => async () => {},
      }),
    ).rejects.toThrow(/contextRoutes.*ctx-bad.*NotAValidTarget/);
  });

  test("P10.7: contextRoutes without roomRouter is a startup error", async () => {
    const port = randomPort();
    await expect(
      startA2AServer({
        port,
        logger: () => {},
        agentCard: cardConfig(port),
        bearerToken: "tok",
        publicAgentCard: true,
        contextRoutes: { "ctx-a": "claude:alice" },
      }),
    ).rejects.toThrow(/contextRoutes requires roomRouter/);
  });
});

describe("parseContextRoutes", () => {
  test("returns null when env var is unset or empty", () => {
    expect(parseContextRoutes(undefined)).toBeNull();
    expect(parseContextRoutes("")).toBeNull();
    expect(parseContextRoutes("   ")).toBeNull();
  });

  test("parses a valid JSON object", () => {
    const res = parseContextRoutes(`{"a":"claude:alice","b":"claude:bob"}`);
    expect(res).toEqual({
      contextRoutes: { a: "claude:alice", b: "claude:bob" },
    });
  });

  test("returns null and logs on malformed JSON", () => {
    const logs: string[] = [];
    expect(parseContextRoutes("{bad", (m) => logs.push(m))).toBeNull();
    expect(logs.join("\n")).toMatch(/not valid JSON/);
  });

  test("drops entries whose value is not a string", () => {
    const logs: string[] = [];
    const res = parseContextRoutes(
      `{"a":"claude:alice","b":42,"c":null}`,
      (m) => logs.push(m),
    );
    expect(res).toEqual({ contextRoutes: { a: "claude:alice" } });
    expect(logs.join("\n")).toMatch(/"b".*not a string/);
  });

  test("returns null when the object is empty (or all entries were dropped)", () => {
    expect(parseContextRoutes(`{}`)).toBeNull();
    expect(parseContextRoutes(`{"a":42}`)).toBeNull();
  });

  test("rejects arrays and primitives", () => {
    const logs: string[] = [];
    expect(parseContextRoutes(`[]`, (m) => logs.push(m))).toBeNull();
    expect(parseContextRoutes(`"string"`, (m) => logs.push(m))).toBeNull();
    expect(logs.join("\n")).toMatch(/expected a JSON object/);
  });
});

class StubGateway implements ClaudeCodeGateway {
  constructor(private readonly label: string) {}
  private active: StubTurn | null = null;
  startTurn(_userText: string): ClaudeCodeTurn {
    const turn = new StubTurn();
    this.active = turn;
    return turn;
  }
  pushAndComplete(): void {
    const turn = this.active;
    if (!turn) throw new Error("no active turn");
    turn.emit("chunk", this.label);
    turn.emit("complete");
    this.active = null;
  }
}

class StubTurn extends EventEmitter implements ClaudeCodeTurn {
  cancel(): void {}
}
