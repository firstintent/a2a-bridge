import { describe, test, expect } from "bun:test";
import { checkBearerAuth } from "@daemon/inbound/a2a-http/auth";

function makeReq(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://bridge.test${path}`, { headers });
}

describe("checkBearerAuth", () => {
  test("allows a correct Bearer token", () => {
    const result = checkBearerAuth(makeReq("/a2a", { authorization: "Bearer secret" }), {
      bearerToken: "secret",
    });
    expect(result).toBeNull();
  });

  test("rejects missing Authorization with 401", async () => {
    const result = checkBearerAuth(makeReq("/a2a"), { bearerToken: "secret" });
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
    expect(result!.headers.get("www-authenticate")).toMatch(/^Bearer /);
  });

  test("rejects a mismatched token with 401", () => {
    const result = checkBearerAuth(
      makeReq("/a2a", { authorization: "Bearer wrong" }),
      { bearerToken: "secret" },
    );
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test("rejects non-Bearer schemes with 401", () => {
    const result = checkBearerAuth(
      makeReq("/a2a", { authorization: "Basic dXNlcjpwYXNz" }),
      { bearerToken: "secret" },
    );
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test("treats empty-string bearerToken config as never-match", () => {
    const result = checkBearerAuth(
      makeReq("/a2a", { authorization: "Bearer " }),
      { bearerToken: "" },
    );
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test("agent-card endpoint is exempt when publicAgentCard=true", () => {
    const result = checkBearerAuth(
      makeReq("/.well-known/agent-card.json"),
      { bearerToken: "secret", publicAgentCard: true },
    );
    expect(result).toBeNull();
  });

  test("agent-card endpoint still requires auth when publicAgentCard=false", () => {
    const result = checkBearerAuth(
      makeReq("/.well-known/agent-card.json"),
      { bearerToken: "secret", publicAgentCard: false },
    );
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test("Bearer scheme match is case-insensitive and tolerates extra whitespace", () => {
    const result = checkBearerAuth(
      makeReq("/a2a", { authorization: "bearer    secret" }),
      { bearerToken: "secret" },
    );
    expect(result).toBeNull();
  });
});
