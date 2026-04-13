/**
 * Test-only `EchoGateway` — a trivial ClaudeCodeGateway implementation
 * that mirrors user text as a single chunk plus a terminal complete.
 *
 * **Why this lives in a `.test.ts` file:** Phase 8 removed the
 * echo-gateway from the production `a2a-bridge acp` code path; the
 * subcommand now relays every turn through the daemon via
 * `DaemonProxyGateway` and fails loudly when the daemon is
 * unreachable.  The `not-to-test` dep-cruiser rule prevents non-test
 * sources from importing anything in a `*.test.ts` file, so moving
 * `EchoGateway` into this file structurally enforces the constraint
 * that only test fixtures may reach for it.
 */
import { EventEmitter } from "node:events";
import { describe, test, expect } from "bun:test";
import type {
  ClaudeCodeGateway,
  ClaudeCodeTurn,
} from "@daemon/inbound/a2a-http/claude-code-gateway";

export class EchoTurn extends EventEmitter implements ClaudeCodeTurn {
  cancel(): void {}
}

export class EchoGateway implements ClaudeCodeGateway {
  startTurn(userText: string): ClaudeCodeTurn {
    const turn = new EchoTurn();
    // Emit async so the handler wires its listeners up first.
    setImmediate(() => {
      turn.emit("chunk", `Echo: ${userText}`);
      turn.emit("complete");
    });
    return turn;
  }
}

describe("EchoGateway (test fixture)", () => {
  test("startTurn emits a single chunk then completes", async () => {
    const gw = new EchoGateway();
    const turn = gw.startTurn("hello");
    const chunks: string[] = [];
    turn.on("chunk", (t) => chunks.push(t));
    await new Promise<void>((resolve) => turn.on("complete", resolve));
    expect(chunks).toEqual(["Echo: hello"]);
  });
});
