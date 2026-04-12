import { describe, test, expect } from "bun:test";
import {
  dispatch,
  type JsonRpcErrorResponse,
} from "@daemon/inbound/a2a-http/jsonrpc";
import {
  TASK_NOT_FOUND,
  handleTasksGet,
} from "@daemon/inbound/a2a-http/handlers/tasks-get";

describe("handleTasksGet stub", () => {
  test("returns TaskNotFound for any known id shape", async () => {
    const resp = (await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: "task-1234" },
        id: 1,
      }),
      { "tasks/get": handleTasksGet },
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(TASK_NOT_FOUND);
    expect(resp.error.message).toContain("task-1234");
    expect(resp.id).toBe(1);
  });

  test("also returns TaskNotFound when id is missing", async () => {
    const resp = (await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/get",
        params: {},
        id: "req-nope",
      }),
      { "tasks/get": handleTasksGet },
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(TASK_NOT_FOUND);
    expect(resp.id).toBe("req-nope");
  });

  test("uses the A2A-reserved error code -32001", () => {
    expect(TASK_NOT_FOUND).toBe(-32001);
  });
});
