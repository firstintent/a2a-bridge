import { describe, test, expect } from "bun:test";
import {
  DEFAULT_ROOM_ID,
  ROOM_ENV_VAR,
  deriveRoomId,
} from "@daemon/rooms/room-id";

describe("deriveRoomId", () => {
  test("returns contextId when present", () => {
    const id = deriveRoomId({ contextId: "ctx-abc123" });
    expect(id).toBe("ctx-abc123" as typeof id);
  });

  test("falls back to A2A_BRIDGE_ROOM when contextId is absent", () => {
    const id = deriveRoomId({ env: { [ROOM_ENV_VAR]: "team-backend" } });
    expect(id).toBe("team-backend" as typeof id);
  });

  test("prefers contextId over the env var when both are set", () => {
    const id = deriveRoomId({
      contextId: "ctx-wins",
      env: { [ROOM_ENV_VAR]: "env-loses" },
    });
    expect(id).toBe("ctx-wins" as typeof id);
  });

  test("returns the default id when neither contextId nor env var is set", () => {
    const id = deriveRoomId({ env: {} });
    expect(id).toBe(DEFAULT_ROOM_ID);
  });

  test("treats empty/whitespace contextId as absent", () => {
    expect(deriveRoomId({ contextId: "", env: {} })).toBe(DEFAULT_ROOM_ID);
    expect(deriveRoomId({ contextId: "   ", env: {} })).toBe(DEFAULT_ROOM_ID);
  });

  test("treats empty/whitespace env var as absent", () => {
    expect(deriveRoomId({ env: { [ROOM_ENV_VAR]: "" } })).toBe(DEFAULT_ROOM_ID);
    expect(deriveRoomId({ env: { [ROOM_ENV_VAR]: "   " } })).toBe(DEFAULT_ROOM_ID);
  });

  test("trims surrounding whitespace from both sources", () => {
    expect(deriveRoomId({ contextId: "  ctx-x  " })).toBe("ctx-x" as ReturnType<typeof deriveRoomId>);
    expect(deriveRoomId({ env: { [ROOM_ENV_VAR]: "  env-x  " } })).toBe(
      "env-x" as ReturnType<typeof deriveRoomId>,
    );
  });

  test("defaults env to process.env when not supplied", () => {
    // Sanity check: no crash, returns some id. Avoids asserting on the
    // host's actual env to stay hermetic.
    const id = deriveRoomId({ contextId: "stable" });
    expect(id).toBe("stable" as typeof id);
  });
});
