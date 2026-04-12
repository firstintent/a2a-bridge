import { describe, test, expect, afterEach } from "bun:test";
import { A2AClient } from "@a2a-js/sdk/client";
import { startA2AServer, type A2aServerHandle } from "@daemon/inbound/a2a-http/server";

/**
 * SDK-level integration test for the A2A inbound surface.
 *
 * Starts `startA2AServer` on an ephemeral port with the default echo
 * executor, then drives it with the same `@a2a-js/sdk` client Gemini
 * CLI uses. Asserts the client observes at least one artifact-update
 * and one terminal status-update with `final: true` — the Phase 2
 * ship criterion in miniature.
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

function track(handle: A2aServerHandle) {
  teardown.push(() => handle.shutdown());
  return handle;
}

/**
 * Bun resolves fetch URLs starting with `http://127.0.0.1` through a
 * path that returns 502 in this WSL2 env; `localhost` works. The SDK
 * fetches the agent card first, then re-uses its `url` field, so we
 * build the card with a `localhost` base to avoid the trap.
 */
function baseUrl(port: number): string {
  return `http://localhost:${port}`;
}

describe("A2A inbound — SDK integration", () => {
  test("A2AClient.sendMessageStream streams artifact-update + terminal status-update", async () => {
    const port = randomPort();
    const bearer = "sdk-test-token";

    const server = track(
      await startA2AServer({
        port,
        logger: () => {},
        bearerToken: bearer,
        publicAgentCard: true,
        agentCard: { url: `${baseUrl(port)}/a2a` },
      }),
    );

    // Build a fetch wrapper that adds the bearer header to every request
    // so card lookup + RPC call both authenticate consistently. Cast
    // through `unknown` because Bun's `fetch` signature carries a
    // `preconnect` property the SDK's minimal `typeof fetch` slot
    // doesn't require.
    const authedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      return fetch(input, { ...init, headers });
    }) as unknown as typeof fetch;

    const client = await A2AClient.fromCardUrl(
      `${baseUrl(server.port)}/.well-known/agent-card.json`,
      { fetchImpl: authedFetch },
    );

    const stream = client.sendMessageStream({
      message: {
        kind: "message",
        messageId: "msg-1",
        role: "user",
        parts: [{ kind: "text", text: "hello from SDK" }],
      },
    });

    let artifactSeen = false;
    let terminalFinal = false;
    let terminalState: string | undefined;

    for await (const event of stream) {
      const kind = (event as { kind?: string }).kind;
      if (kind === "artifact-update") {
        artifactSeen = true;
      } else if (kind === "status-update") {
        const e = event as { final?: boolean; status?: { state?: string } };
        if (e.final) {
          terminalFinal = true;
          terminalState = e.status?.state;
        }
      }
    }

    expect(artifactSeen).toBe(true);
    expect(terminalFinal).toBe(true);
    expect(terminalState).toBe("completed");
  });
});
