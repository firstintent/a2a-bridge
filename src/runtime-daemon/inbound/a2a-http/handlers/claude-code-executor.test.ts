import { describe, test, expect, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { startA2AServer, type A2aServerHandle } from "@daemon/inbound/a2a-http/server";
import {
  createClaudeCodeExecutor,
  handleMessageStream,
} from "@daemon/inbound/a2a-http/handlers/message-stream";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";

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

function track(handle: A2aServerHandle) {
  teardown.push(() => handle.shutdown());
  return handle;
}

type ChunkScript = string[];

function mockGateway(script: ChunkScript, opts: { failWith?: string } = {}): {
  gateway: ClaudeCodeGateway;
  received: string[];
} {
  const received: string[] = [];
  const gateway: ClaudeCodeGateway = {
    startTurn(userText) {
      received.push(userText);
      const turn = new EventEmitter() as ClaudeCodeTurn & { cancel: () => void };
      (turn as unknown as { cancel: () => void }).cancel = () => {};
      // Schedule replies asynchronously so the executor has time to
      // attach listeners before events fire.
      void (async () => {
        for (const chunk of script) {
          await new Promise<void>((r) => setTimeout(r, 2));
          turn.emit("chunk", chunk);
        }
        await new Promise<void>((r) => setTimeout(r, 2));
        if (opts.failWith) {
          turn.emit("error", new Error(opts.failWith));
        } else {
          turn.emit("complete");
        }
      })();
      return turn;
    },
  };
  return { gateway, received };
}

async function readSseFrames(resp: Response): Promise<Array<{ result: Record<string, unknown> }>> {
  const frames: Array<{ result: Record<string, unknown> }> = [];
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const rec = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = rec
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice("data: ".length))
        .join("");
      if (data) frames.push(JSON.parse(data));
    }
    if (done) break;
  }
  return frames;
}

describe("createClaudeCodeExecutor", () => {
  test("forwards user text to the gateway and streams chunks as artifact-update(append)", async () => {
    const { gateway, received } = mockGateway(["Hello", ", ", "world!"]);

    const resp = handleMessageStream({
      rpcId: "r1",
      params: { message: { parts: [{ kind: "text", text: "hi" }] } },
      executor: createClaudeCodeExecutor({ gateway }),
    });

    const frames = await readSseFrames(resp);
    expect(received).toEqual(["hi"]);

    const [task, working, a1, a2, a3, final] = frames.map((f) => f.result);
    expect(task!.kind).toBe("task");
    expect((working as { status: { state: string } }).status.state).toBe("working");

    const artifactTexts = [a1, a2, a3].map(
      (f) => (f as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text,
    );
    expect(artifactTexts).toEqual(["Hello", ", ", "world!"]);
    for (const art of [a1, a2, a3]) {
      expect((art as { kind: string }).kind).toBe("artifact-update");
      expect((art as { append: boolean }).append).toBe(true);
    }

    expect((final as { kind: string }).kind).toBe("status-update");
    expect((final as { final: boolean }).final).toBe(true);
    expect((final as { status: { state: string } }).status.state).toBe("completed");
  });

  test("surfaces gateway errors as a terminal status-update(failed)", async () => {
    const { gateway } = mockGateway(["partial"], { failWith: "boom" });
    const resp = handleMessageStream({
      rpcId: "r2",
      params: { message: { parts: [{ kind: "text", text: "x" }] } },
      executor: createClaudeCodeExecutor({ gateway }),
    });

    const frames = await readSseFrames(resp);
    const last = frames[frames.length - 1]!.result as { kind: string; final: boolean; status: { state: string } };
    expect(last.kind).toBe("status-update");
    expect(last.final).toBe(true);
    expect(last.status.state).toBe("failed");
  });

  test("end-to-end HTTP: POST message/stream streams gateway chunks back to the client", async () => {
    const port = randomPort();
    const { gateway, received } = mockGateway(["hi ", "there"]);

    const server = track(
      await startA2AServer({
        port,
        logger: () => {},
        bearerToken: "tok",
        publicAgentCard: true,
        agentCard: { url: `http://localhost:${port}/a2a` },
        messageStreamExecutor: createClaudeCodeExecutor({ gateway }),
      }),
    );

    const resp = await fetch(`http://localhost:${server.port}${server.rpcPath}`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "message/stream",
        params: { message: { parts: [{ kind: "text", text: "ask CC" }] } },
        id: "s1",
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const frames = await readSseFrames(resp);
    expect(received).toEqual(["ask CC"]);

    const artifactTexts = frames
      .map((f) => f.result)
      .filter((r) => (r as { kind: string }).kind === "artifact-update")
      .map((r) => (r as { artifact: { parts: Array<{ text: string }> } }).artifact.parts[0]!.text);
    expect(artifactTexts).toEqual(["hi ", "there"]);

    const terminal = frames[frames.length - 1]!.result as {
      kind: string;
      final: boolean;
      status: { state: string };
    };
    expect(terminal.kind).toBe("status-update");
    expect(terminal.final).toBe(true);
    expect(terminal.status.state).toBe("completed");
  });
});
