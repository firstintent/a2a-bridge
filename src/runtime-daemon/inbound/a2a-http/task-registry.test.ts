import { describe, test, expect } from "bun:test";
import { TaskRegistry, type Task } from "@daemon/inbound/a2a-http/task-registry";

function makeTask(id: string): Task {
  return { id, contextId: `ctx-${id}`, kind: "task", status: { state: "submitted" } };
}

describe("TaskRegistry", () => {
  test("stores and retrieves tasks by id", () => {
    const reg = new TaskRegistry();
    const t = makeTask("t-1");
    reg.create(t);
    expect(reg.get("t-1")).toBe(t);
    expect(reg.size).toBe(1);
  });

  test("get() returns undefined for unknown ids", () => {
    const reg = new TaskRegistry();
    expect(reg.get("missing")).toBeUndefined();
  });

  test("create() throws on duplicate id", () => {
    const reg = new TaskRegistry();
    reg.create(makeTask("t-1"));
    expect(() => reg.create(makeTask("t-1"))).toThrow(/already registered/);
  });

  test("updateStatus() replaces the status in place", () => {
    const reg = new TaskRegistry();
    reg.create(makeTask("t-2"));
    reg.updateStatus("t-2", { state: "working" });
    expect(reg.get("t-2")!.status.state).toBe("working");
  });

  test("updateStatus() on an unknown id is a no-op", () => {
    const reg = new TaskRegistry();
    expect(() => reg.updateStatus("missing", { state: "working" })).not.toThrow();
  });

  test("cancel() flips state, emits cancel event, returns the task", () => {
    const reg = new TaskRegistry();
    reg.create(makeTask("t-3"));

    const events: string[] = [];
    reg.on("cancel", (id) => events.push(id));

    const canceled = reg.cancel("t-3");
    expect(canceled).toBeDefined();
    expect(canceled!.status.state).toBe("canceled");
    expect(reg.get("t-3")!.status.state).toBe("canceled");
    expect(events).toEqual(["t-3"]);
  });

  test("cancel() returns undefined for unknown ids and does not emit", () => {
    const reg = new TaskRegistry();
    let fired = 0;
    reg.on("cancel", () => {
      fired += 1;
    });
    expect(reg.cancel("nope")).toBeUndefined();
    expect(fired).toBe(0);
  });

  test("delete() removes the task", () => {
    const reg = new TaskRegistry();
    reg.create(makeTask("t-4"));
    reg.delete("t-4");
    expect(reg.get("t-4")).toBeUndefined();
    expect(reg.size).toBe(0);
  });
});
