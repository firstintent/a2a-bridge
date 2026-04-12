import { describe, test, expect } from "bun:test";
import {
  createEchoExecutor,
  handleMessageStream,
} from "@daemon/inbound/a2a-http/handlers/message-stream";

type SseFrame = { jsonrpc: "2.0"; id: string | number | null; result: Record<string, unknown> };

async function readSseFrames(resp: Response): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const record = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = record
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("");
      if (lines.length > 0) frames.push(JSON.parse(lines) as SseFrame);
    }
    if (done) break;
  }
  return frames;
}

function deterministicIds(): { idFactory: () => string; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    idFactory: () => {
      n += 1;
      const id = `id-${n}`;
      calls.push(id);
      return id;
    },
  };
}

describe("handleMessageStream", () => {
  test("returns a text/event-stream response with the JSON-RPC id echoed on each frame", async () => {
    const { idFactory } = deterministicIds();
    const resp = handleMessageStream({
      rpcId: "req-42",
      params: {
        message: {
          kind: "message",
          role: "user",
          parts: [{ kind: "text", text: "hello" }],
        },
      },
      executor: createEchoExecutor({ idFactory }),
      idFactory,
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");

    const frames = await readSseFrames(resp);
    expect(frames).toHaveLength(4);
    for (const f of frames) {
      expect(f.jsonrpc).toBe("2.0");
      expect(f.id).toBe("req-42");
    }
  });

  test("emits task, status-update(working), artifact-update, terminal status-update in order", async () => {
    const { idFactory } = deterministicIds();
    const resp = handleMessageStream({
      rpcId: 1,
      params: {
        message: {
          parts: [{ kind: "text", text: "ping" }],
        },
      },
      executor: createEchoExecutor({ idFactory }),
      idFactory,
    });

    const frames = await readSseFrames(resp);
    const [task, working, artifact, done] = frames.map((f) => f.result);

    expect(task!.kind).toBe("task");
    expect((task as { id: string }).id).toBeTruthy();
    expect((task as { contextId: string }).contextId).toBeTruthy();
    expect((task as { status: { state: string } }).status.state).toBe("submitted");

    expect(working!.kind).toBe("status-update");
    expect((working as { status: { state: string } }).status.state).toBe("working");
    expect((working as { final?: boolean }).final).toBe(false);

    expect(artifact!.kind).toBe("artifact-update");
    const artText = (
      artifact as { artifact: { parts: Array<{ text: string }> } }
    ).artifact.parts[0]!.text;
    expect(artText).toBe("ping");

    expect(done!.kind).toBe("status-update");
    expect((done as { final: boolean }).final).toBe(true);
    expect((done as { status: { state: string } }).status.state).toBe("completed");
    const terminalMsg = (done as { status: { message?: { parts: Array<{ text: string }> } } })
      .status.message;
    expect(terminalMsg).toBeDefined();
    expect(terminalMsg!.parts[0]!.text.length).toBeGreaterThan(0);
  });

  test("echoes supplied contextId on every event", async () => {
    const { idFactory } = deterministicIds();
    const resp = handleMessageStream({
      rpcId: "ctx-test",
      params: {
        message: {
          contextId: "ctx-123",
          parts: [{ kind: "text", text: "hello" }],
        },
      },
      executor: createEchoExecutor({ idFactory }),
      idFactory,
    });

    const frames = await readSseFrames(resp);
    for (const f of frames) {
      const ctx = (f.result as { contextId?: string }).contextId;
      expect(ctx).toBe("ctx-123");
    }
  });

  test("emits a terminal failed status-update when the executor throws", async () => {
    const { idFactory } = deterministicIds();
    const resp = handleMessageStream({
      rpcId: 9,
      params: {
        message: {
          parts: [{ kind: "text", text: "hi" }],
        },
      },
      executor: () => {
        throw new Error("boom");
      },
      idFactory,
    });

    const frames = await readSseFrames(resp);
    const last = frames[frames.length - 1]!.result;
    expect(last.kind).toBe("status-update");
    expect((last as { final: boolean }).final).toBe(true);
    expect((last as { status: { state: string } }).status.state).toBe("failed");
  });

  test("each SSE record is terminated by a blank line", async () => {
    const { idFactory } = deterministicIds();
    const resp = handleMessageStream({
      rpcId: 1,
      params: { message: { parts: [{ kind: "text", text: "x" }] } },
      executor: createEchoExecutor({ idFactory }),
      idFactory,
    });
    const body = await resp.text();
    // Four frames → body ends with \n\n, and every "data:" line is
    // followed by a blank-line delimiter.
    const recordBreaks = body.split("\n\n").filter((r) => r.length > 0);
    expect(recordBreaks.length).toBe(4);
  });
});
