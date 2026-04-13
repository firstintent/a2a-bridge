/**
 * `RoomId` derivation for inbound requests.
 *
 * Precedence (highest first) matches `ROADMAP.md` §"Phase 4":
 *   1. The caller's `contextId` — every A2A inbound call mints one.
 *   2. `A2A_BRIDGE_ROOM` env var — for CLI-style callers that want a
 *      stable room across calls without threading a `contextId`.
 *   3. The literal string `"default"` — single-room behaviour,
 *      matches the pre-Phase-4 topology.
 */

declare const RoomIdBrand: unique symbol;
export type RoomId = string & { readonly [RoomIdBrand]: "RoomId" };

export const DEFAULT_ROOM_ID: RoomId = "default" as RoomId;
export const ROOM_ENV_VAR = "A2A_BRIDGE_ROOM";

export interface DeriveRoomIdInput {
  contextId?: string;
  /** Process env or a test double thereof. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export function deriveRoomId(input: DeriveRoomIdInput = {}): RoomId {
  const contextId = input.contextId?.trim();
  if (contextId && contextId.length > 0) {
    return contextId as RoomId;
  }

  const envRoom = (input.env ?? process.env)[ROOM_ENV_VAR]?.trim();
  if (envRoom && envRoom.length > 0) {
    return envRoom as RoomId;
  }

  return DEFAULT_ROOM_ID;
}
