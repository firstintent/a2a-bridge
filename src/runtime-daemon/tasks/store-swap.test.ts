import { describe, test, expect } from "bun:test";
import { TaskRegistry } from "@daemon/inbound/a2a-http/task-registry";
import { SqliteTaskLog } from "@daemon/tasks/task-log";
import type { ITaskStore } from "@daemon/tasks/task-store";

/**
 * Cross-implementation contract test: every `ITaskStore` must behave
 * identically against the handler-shaped scenarios `message/stream`,
 * `tasks/get`, and `tasks/cancel` exercise. Runs the same body against
 * both `TaskRegistry` (in-memory) and `SqliteTaskLog` (:memory:).
 */

interface StoreFactory {
  label: string;
  make(): ITaskStore;
}

const factories: StoreFactory[] = [
  { label: "TaskRegistry", make: () => new TaskRegistry() },
  { label: "SqliteTaskLog", make: () => SqliteTaskLog.open(":memory:") },
];

for (const { label, make } of factories) {
  describe(`ITaskStore contract: ${label}`, () => {
    test("create + get + updateStatus reflects the latest state", () => {
      const store = make();
      store.create({
        id: "t-1",
        contextId: "ctx-1",
        kind: "task",
        status: { state: "submitted" },
      });
      expect(store.get("t-1")?.status.state).toBe("submitted");

      store.updateStatus("t-1", {
        state: "completed",
        message: { parts: [{ kind: "text", text: "done" }] },
      });
      const after = store.get("t-1");
      expect(after?.status.state).toBe("completed");
      const msg = after?.status.message as { parts: Array<{ text: string }> } | undefined;
      expect(msg?.parts[0]?.text).toBe("done");
    });

    test("create throws on duplicate id", () => {
      const store = make();
      store.create({
        id: "dup",
        contextId: "c",
        kind: "task",
        status: { state: "submitted" },
      });
      expect(() =>
        store.create({
          id: "dup",
          contextId: "c",
          kind: "task",
          status: { state: "submitted" },
        }),
      ).toThrow(/already registered/);
    });

    test("updateStatus is a no-op when the task is gone", () => {
      const store = make();
      store.updateStatus("missing", { state: "ignored" });
      expect(store.get("missing")).toBeUndefined();
    });

    test("cancel flips state + emits a cancel event; missing id returns undefined", () => {
      const store = make();
      store.create({
        id: "to-cancel",
        contextId: "c",
        kind: "task",
        status: { state: "submitted" },
      });
      const seen: string[] = [];
      store.on("cancel", (id) => seen.push(id));

      const canceled = store.cancel("to-cancel");
      expect(canceled?.status.state).toBe("canceled");
      expect(seen).toEqual(["to-cancel"]);

      const missing = store.cancel("never-existed");
      expect(missing).toBeUndefined();
      expect(seen).toEqual(["to-cancel"]);
    });

    test("off removes a cancel listener", () => {
      const store = make();
      store.create({
        id: "off-test",
        contextId: "c",
        kind: "task",
        status: { state: "submitted" },
      });
      let hits = 0;
      const listener = () => {
        hits += 1;
      };
      store.on("cancel", listener);
      store.off("cancel", listener);
      store.cancel("off-test");
      expect(hits).toBe(0);
    });
  });
}
