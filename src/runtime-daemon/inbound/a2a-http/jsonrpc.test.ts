import { describe, test, expect } from "bun:test";
import {
  dispatch,
  JSON_RPC_ERRORS,
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
} from "@daemon/inbound/a2a-http/jsonrpc";

describe("dispatch", () => {
  test("routes a valid request to the matching handler and wraps the result", async () => {
    const resp = (await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "echo", params: { text: "hi" }, id: 42 }),
      { echo: (params) => ({ echoed: (params as { text: string }).text }) },
    )) as JsonRpcSuccessResponse;

    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(42);
    expect(resp.result).toEqual({ echoed: "hi" });
  });

  test("awaits async handlers", async () => {
    const resp = (await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "slow", id: "req-1" }),
      {
        slow: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return "done";
        },
      },
    )) as JsonRpcSuccessResponse;

    expect(resp.id).toBe("req-1");
    expect(resp.result).toBe("done");
  });

  test("returns METHOD_NOT_FOUND for unknown methods", async () => {
    const resp = (await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "nope", id: "m1" }),
      { echo: () => null },
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
    expect(resp.id).toBe("m1");
  });

  test("returns PARSE_ERROR with id null for malformed JSON", async () => {
    const resp = (await dispatch("not{json", {})) as JsonRpcErrorResponse;
    expect(resp.error.code).toBe(JSON_RPC_ERRORS.PARSE_ERROR);
    expect(resp.id).toBeNull();
  });

  test("returns INVALID_REQUEST for missing jsonrpc field", async () => {
    const resp = (await dispatch(
      JSON.stringify({ method: "echo", id: 1 }),
      { echo: () => null },
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
    expect(resp.id).toBe(1);
  });

  test("returns INVALID_REQUEST for non-string method", async () => {
    const resp = (await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: 123, id: 2 }),
      {},
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
    expect(resp.id).toBe(2);
  });

  test("returns INVALID_REQUEST with id null for non-object payload", async () => {
    const resp = (await dispatch("[]", {})) as JsonRpcErrorResponse;
    expect(resp.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
    expect(resp.id).toBeNull();
  });

  test("returns null for valid notifications (no id)", async () => {
    let called = 0;
    const resp = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
      {
        ping: () => {
          called += 1;
          return "pong";
        },
      },
    );

    expect(resp).toBeNull();
    expect(called).toBe(1);
  });

  test("returns null for notifications even when the method is unknown", async () => {
    const resp = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "missing" }),
      {},
    );
    expect(resp).toBeNull();
  });

  test("handler throws → INTERNAL_ERROR", async () => {
    const resp = (await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "boom", id: "x" }),
      {
        boom: () => {
          throw new Error("kaboom");
        },
      },
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(JSON_RPC_ERRORS.INTERNAL_ERROR);
    expect(resp.error.message).toContain("kaboom");
    expect(resp.id).toBe("x");
  });

  test("null-result handlers still produce a success response with result: null", async () => {
    const resp = (await dispatch(
      JSON.stringify({ jsonrpc: "2.0", method: "void", id: 7 }),
      { void: () => undefined },
    )) as JsonRpcSuccessResponse;

    expect(resp.result).toBeNull();
    expect(resp.id).toBe(7);
  });
});
