import { describe, expect, it } from "vitest";
import type { SocketStatus } from "../net/room-socket";
import { pendingText, STATUS_TEXT } from "./ui";

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
  const all: SocketStatus[] = ["idle", "connecting", "open", "waiting", "closed", "unsupported_protocol"];

  it("has a distinct, non-empty message for every connection state", () => {
    const messages = all.map((status) => STATUS_TEXT[status]);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(all.length);
  });

  it("tells the person to reload when their version is refused", () => {
    expect(STATUS_TEXT.unsupported_protocol).toMatch(/reload/i);
  });
});
