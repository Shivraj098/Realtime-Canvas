import { describe, expect, it, vi } from "vitest";
import type { Op } from "@realtime-canvas/shared";
import type { WebSocket } from "ws";
import { Room, RoomManager } from "./room";

/**
 * A minimal fake socket exposing only what Room touches (readyState,
 * OPEN, send). Kept as its own mutable type rather than cast to
 * WebSocket so tests can change `readyState`, which is read-only on the
 * real type.
 */
type FakeSocket = { readyState: number; OPEN: number; send: (data: string) => void; sent: string[] };

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  return { readyState: 1, OPEN: 1, send: (data: string) => sent.push(data), sent };
}

function asWebSocket(fake: FakeSocket): WebSocket {
  return fake as unknown as WebSocket;
}

function createOp(shapeId: string, physical: number): Op {
  return {
    type: "create_shape",
    shapeId,
    roomId: "room1",
    fields: { x: 0, y: 0, width: 10, height: 10, color: "#000" },
    hlc: { physical, logical: 0, nodeId: "server" },
    opId: `op-${shapeId}`,
  };
}

describe("Room", () => {
  it("starts with empty state when constructed with no existing ops", () => {
    expect(new Room("room1").state).toEqual({});
  });

  it("replays existing ops on construction to rebuild state (server-restart recovery)", () => {
    const room = new Room("room1", [createOp("s1", 100), createOp("s2", 200)]);
    expect(Object.keys(room.state)).toEqual(["s1", "s2"]);
  });

  it("assigns each connection a color not already in use in that room", () => {
    const room = new Room("room1");
    const a = room.addClient("clientA", asWebSocket(fakeSocket()));
    const b = room.addClient("clientB", asWebSocket(fakeSocket()));
    expect(a.color).not.toBe(b.color);
  });

  it("keeps assigning colors (cycling) once the palette is exhausted", () => {
    const room = new Room("room1");
    for (let i = 0; i < 12; i++) {
      expect(room.addClient(`client${i}`, asWebSocket(fakeSocket())).color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(room.presenceList()).toHaveLength(12);
  });

  it("removeClient drops exactly that connection from presence", () => {
    const room = new Room("room1");
    const socket = asWebSocket(fakeSocket());
    room.addClient("clientA", socket);
    expect(room.presenceList()).toHaveLength(1);
    expect(room.removeClient(socket)).toBe(true);
    expect(room.presenceList()).toHaveLength(0);
  });

  it("removeClient reports false for a socket that was never added", () => {
    expect(new Room("room1").removeClient(asWebSocket(fakeSocket()))).toBe(false);
  });

  it("tracks two connections with the same clientId independently (reconnect / two tabs)", () => {
    const room = new Room("room1");
    const oldSocket = fakeSocket();
    const newSocket = fakeSocket();
    room.addClient("clientA", asWebSocket(oldSocket));
    room.addClient("clientA", asWebSocket(newSocket));
    expect(room.presenceList()).toHaveLength(2);

    // The regression this guards against: the OLD connection closing must
    // not remove the NEW connection from the room.
    room.removeClient(asWebSocket(oldSocket));
    room.broadcast("hello");

    expect(newSocket.sent).toEqual(["hello"]);
    expect(oldSocket.sent).toEqual([]);
  });

  it("applyAndCache folds a new op into room.state", () => {
    const room = new Room("room1");
    room.applyAndCache(createOp("s1", 100));
    expect(room.state.s1).toBeDefined();
  });

  it("broadcast sends the payload to every connected client", () => {
    const room = new Room("room1");
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    room.addClient("clientA", asWebSocket(socketA));
    room.addClient("clientB", asWebSocket(socketB));

    room.broadcast("hello");

    expect(socketA.sent).toEqual(["hello"]);
    expect(socketB.sent).toEqual(["hello"]);
  });

  it("broadcast skips the socket passed as the exception (the sender)", () => {
    const room = new Room("room1");
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    room.addClient("clientA", asWebSocket(socketA));
    room.addClient("clientB", asWebSocket(socketB));

    room.broadcast("hello", asWebSocket(socketA));

    expect(socketA.sent).toEqual([]);
    expect(socketB.sent).toEqual(["hello"]);
  });

  it("broadcast skips connections that are not OPEN", () => {
    const room = new Room("room1");
    const closedSocket = fakeSocket();
    closedSocket.readyState = 3; // CLOSED
    room.addClient("clientA", asWebSocket(closedSocket));

    room.broadcast("hello");

    expect(closedSocket.sent).toEqual([]);
  });
});

describe("RoomManager", () => {
  it("lazily creates a room on first access, loading its ops via the provided loader", () => {
    const loadOps = vi.fn((roomId: string) => (roomId === "room1" ? [createOp("s1", 100)] : []));
    const manager = new RoomManager(loadOps);

    const room = manager.get("room1");

    expect(loadOps).toHaveBeenCalledWith("room1");
    expect(room.state.s1).toBeDefined();
  });

  it("returns the same Room instance on repeated access without reloading", () => {
    const loadOps = vi.fn(() => []);
    const manager = new RoomManager(loadOps);

    expect(manager.get("room1")).toBe(manager.get("room1"));
    expect(loadOps).toHaveBeenCalledTimes(1);
  });

  it("keeps separate rooms independent", () => {
    const manager = new RoomManager(() => []);
    const roomA = manager.get("roomA");
    const roomB = manager.get("roomB");
    roomA.applyAndCache(createOp("s1", 100));
    expect(roomB.state).toEqual({});
  });
});
