import { describe, test, expect } from "bun:test";
import { DaemonClaudeCodeGateway } from "@daemon/inbound/daemon-claude-code-gateway";

describe("DaemonClaudeCodeGateway", () => {
  test("startTurn forwards user text via sendToClaude", () => {
    const sent: string[] = [];
    const gateway = new DaemonClaudeCodeGateway({
      sendToClaude: (text) => sent.push(text),
    });

    gateway.startTurn("hello CC");

    expect(sent).toEqual(["hello CC"]);
    expect(gateway.hasActiveTurn()).toBe(true);
  });

  test("interceptReply delivers chunk + complete to the active turn and clears it", async () => {
    const gateway = new DaemonClaudeCodeGateway({ sendToClaude: () => {} });
    const turn = gateway.startTurn("ping");

    const chunks: string[] = [];
    let completed = 0;
    turn.on("chunk", (text) => chunks.push(text));
    turn.on("complete", () => {
      completed += 1;
    });

    expect(gateway.interceptReply("pong")).toBe(true);

    expect(chunks).toEqual(["pong"]);
    expect(completed).toBe(1);
    expect(gateway.hasActiveTurn()).toBe(false);
  });

  test("interceptReply returns false when no turn is active", () => {
    const gateway = new DaemonClaudeCodeGateway({ sendToClaude: () => {} });
    expect(gateway.interceptReply("orphan")).toBe(false);
  });

  test("starting a new turn while one is active emits error on the previous", () => {
    const gateway = new DaemonClaudeCodeGateway({ sendToClaude: () => {} });
    const first = gateway.startTurn("first");

    let firstError: Error | undefined;
    first.on("error", (err) => {
      firstError = err;
    });

    const second = gateway.startTurn("second");

    expect(firstError).toBeInstanceOf(Error);
    expect(firstError!.message).toMatch(/replaced/);
    expect(gateway.hasActiveTurn()).toBe(true);

    let secondCompleted = 0;
    second.on("complete", () => {
      secondCompleted += 1;
    });
    expect(gateway.interceptReply("only second")).toBe(true);
    expect(secondCompleted).toBe(1);
  });

  test("turn.cancel() emits error and clears the active turn", () => {
    const gateway = new DaemonClaudeCodeGateway({ sendToClaude: () => {} });
    const turn = gateway.startTurn("hi");

    let canceled: Error | undefined;
    turn.on("error", (err) => {
      canceled = err;
    });

    turn.cancel();

    expect(canceled).toBeInstanceOf(Error);
    expect(gateway.hasActiveTurn()).toBe(false);
  });

  test("sendToClaude failure surfaces as a deferred error on the turn", async () => {
    const gateway = new DaemonClaudeCodeGateway({
      sendToClaude: () => {
        throw new Error("plugin offline");
      },
    });

    const turn = gateway.startTurn("user text");
    expect(gateway.hasActiveTurn()).toBe(false);

    const reason = await new Promise<Error>((resolve) => {
      turn.on("error", (err) => resolve(err));
    });
    expect(reason.message).toMatch(/plugin offline/);
  });
});
