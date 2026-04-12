import { describe, test, expect } from "bun:test";
import {
  dispatch,
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
} from "@daemon/inbound/a2a-http/jsonrpc";
import { createTasksCancelHandler } from "@daemon/inbound/a2a-http/handlers/tasks-cancel";
import { TASK_NOT_FOUND } from "@daemon/inbound/a2a-http/handlers/tasks-get";
import { TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";

describe("createTasksCancelHandler", () => {
  test("flips the stored task's state to canceled and returns it", async () => {
    const registry = new TaskRegistry();
    registry.create({
      id: "t-7",
      contextId: "ctx",
      kind: "task",
      status: { state: "working" },
    });

    const resp = (await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/cancel",
        params: { id: "t-7" },
        id: "c1",
      }),
      { "tasks/cancel": createTasksCancelHandler(registry) },
    )) as JsonRpcSuccessResponse;

    const result = resp.result as { id: string; status: { state: string } };
    expect(result.id).toBe("t-7");
    expect(result.status.state).toBe("canceled");
    expect(registry.get("t-7")!.status.state).toBe("canceled");
  });

  test("fires a cancel event so active streams can terminate", async () => {
    const registry = new TaskRegistry();
    registry.create({
      id: "t-8",
      contextId: "ctx",
      kind: "task",
      status: { state: "working" },
    });

    const events: string[] = [];
    registry.on("cancel", (id) => events.push(id));

    await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/cancel",
        params: { id: "t-8" },
        id: 2,
      }),
      { "tasks/cancel": createTasksCancelHandler(registry) },
    );

    expect(events).toEqual(["t-8"]);
  });

  test("returns TaskNotFound for an unknown id", async () => {
    const registry = new TaskRegistry();
    const resp = (await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/cancel",
        params: { id: "nope" },
        id: 3,
      }),
      { "tasks/cancel": createTasksCancelHandler(registry) },
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(TASK_NOT_FOUND);
  });

  test("missing id in params also yields TaskNotFound", async () => {
    const registry = new TaskRegistry();
    const resp = (await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/cancel",
        params: {},
        id: 4,
      }),
      { "tasks/cancel": createTasksCancelHandler(registry) },
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(TASK_NOT_FOUND);
  });
});
