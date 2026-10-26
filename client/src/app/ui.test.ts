import { describe, expect, it } from "vitest";
import type { SocketStatus } from "../net/room-socket";
import type { RoomClientEvent } from "../room-client";
import { noticeFor, pendingText, STATUS_TEXT } from "./ui";

describe("pendingText", () => {
  it("says nothing when everything is synced", () => {
    expect(pendingText(0)).toBe("");
  });

  it("uses the singular for one change and the plural otherwise", () => {
    expect(pendingText(1)).toBe("1 unsynced change");
    expect(pendingText(2)).toBe("2 unsynced changes");
    expect(pendingText(40)).toBe("40 unsynced changes");
  });
});

describe("STATUS_TEXT", () => {
  const all: SocketStatus[] = [
    "idle",
    "connecting",
    "open",
    "waiting",
    "closed",
    "unsupported_protocol",
    "refused",
  ];

  it("has a distinct, non-empty message for every connection state", () => {
    const messages = all.map((status) => STATUS_TEXT[status]);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(all.length);
  });

  it("tells the person to reload when their version is refused", () => {
    expect(STATUS_TEXT.unsupported_protocol).toMatch(/reload/i);
  });
});

describe("noticeFor", () => {
  const rejected = (
    reason: Extract<RoomClientEvent, { type: "op_rejected" }>["reason"],
    retryable = false,
  ): RoomClientEvent => ({
    type: "op_rejected",
    opId: "o",
    reason,
    retryable,
  });
  const error = (code: string): RoomClientEvent => ({ type: "server_error", code, message: "m" });

  it.each([
    ["a board that is full", rejected("room_full"), /board is full/i],
    ["a server that is full", rejected("server_full"), /server is full/i],
    ["editing too fast", rejected("rate_limited", true), /very fast/i],
    ["a shape someone else removed", rejected("unknown_shape"), /removed/i],
    ["a full room", error("room_full"), /room is full/i],
    ["a busy server", error("server_busy"), /busy/i],
    ["being cut off for flooding", error("rate_limited"), /too many messages/i],
    ["a room link that is not allowed", error("invalid_room"), /not allowed/i],
  ])("says something useful for %s", (_name, event, expected) => {
    expect(noticeFor(event)).toMatch(expected);
  });

  it.each([
    ["an invalid op", rejected("invalid")],
    ["a duplicate shape id", rejected("shape_exists")],
    ["a not-joined op", rejected("not_joined")],
    ["an unknown error code", error("something_new")],
    ["a resync", { type: "resync_requested" } as RoomClientEvent],
  ])("stays quiet for %s: nothing the person can act on", (_name, event) => {
    expect(noticeFor(event)).toBeNull();
  });
});
