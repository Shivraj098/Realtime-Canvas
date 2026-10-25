import { describe, expect, it } from "vitest";
import { generateRoomId, isValidRoomId, roomIdFromSearch, serverUrl } from "./room-id";

describe("isValidRoomId", () => {
  it.each(["abc", "A-b_9", "x".repeat(64)])("accepts %s", (id) => {
    expect(isValidRoomId(id)).toBe(true);
  });

  it.each(["", "has space", "slash/slash", "dot.dot", "ünï", "x".repeat(65), "a\nb"])("rejects %j", (id) => {
    expect(isValidRoomId(id)).toBe(false);
  });
});

describe("generateRoomId", () => {
  it("makes a valid id of 22 characters from 128 bits", () => {
    const id = generateRoomId((bytes) => bytes.fill(255));
    expect(id).toHaveLength(22);
    expect(isValidRoomId(id)).toBe(true);
  });

  it("uses only URL-safe characters whatever the bytes are", () => {
    for (const value of [0, 62, 63, 251, 255]) {
      expect(generateRoomId((bytes) => bytes.fill(value))).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("differs from call to call with the real random source", () => {
    expect(generateRoomId()).not.toBe(generateRoomId());
  });
});

describe("roomIdFromSearch", () => {
  it("reads the room parameter", () => {
    expect(roomIdFromSearch("?room=abc123")).toBe("abc123");
    expect(roomIdFromSearch("?x=1&room=abc123")).toBe("abc123");
  });

  it("ignores a missing, empty or unusable room", () => {
    expect(roomIdFromSearch("")).toBeNull();
    expect(roomIdFromSearch("?other=1")).toBeNull();
    expect(roomIdFromSearch("?room=")).toBeNull();
    expect(roomIdFromSearch("?room=bad%20id")).toBeNull();
    expect(roomIdFromSearch(`?room=${"x".repeat(65)}`)).toBeNull();
  });
});

describe("serverUrl", () => {
  it("uses the configured address when there is one", () => {
    expect(serverUrl("wss://example.com", { protocol: "http:", hostname: "localhost" })).toBe(
      "wss://example.com",
    );
  });

  it("falls back to the same host on the server's default port, matching the page's security", () => {
    expect(serverUrl(undefined, { protocol: "http:", hostname: "localhost" })).toBe("ws://localhost:8080");
    expect(serverUrl("", { protocol: "https:", hostname: "app.test" })).toBe("wss://app.test:8080");
  });
});
