import { describe, test, expect } from "bun:test";
import {
  dispatch,
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
} from "@daemon/inbound/a2a-http/jsonrpc";
import {
  TASK_NOT_FOUND,
  createTasksGetHandler,
  handleTasksGet,
} from "@daemon/inbound/a2a-http/handlers/tasks-get";
import { TaskRegistry, type Task } from "@daemon/inbound/a2a-http/task-registry";

describe("createTasksGetHandler", () => {
  test("returns the registered Task for a known id", async () => {
    const registry = new TaskRegistry();
    const task: Task = {
      id: "task-9",
      contextId: "ctx",
      kind: "task",
      status: { state: "working" },
    };
    registry.create(task);

    const resp = (await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: "task-9" },
        id: 1,
      }),
      { "tasks/get": createTasksGetHandler(registry) },
    )) as JsonRpcSuccessResponse;

    expect(resp.result).toBe(task);
  });

  test("returns TaskNotFound for an unknown id", async () => {
    const registry = new TaskRegistry();
    const resp = (await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: "missing" },
        id: "g1",
      }),
      { "tasks/get": createTasksGetHandler(registry) },
    )) as JsonRpcErrorResponse;

    expect(resp.error.code).toBe(TASK_NOT_FOUND);
  });

  test("returns TaskNotFound when no registry is supplied (pre-wiring)", async () => {
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
  });

  test("uses the A2A-reserved error code -32001", () => {
    expect(TASK_NOT_FOUND).toBe(-32001);
  });
});
