import { describe, expect, it, vi } from "vitest";
import { applyOps, type RoomState } from "@realtime-canvas/shared";
import { OpLog, type StoredSnapshot } from "./op-log";
import type { Op } from "@realtime-canvas/shared";
import type { WebSocket } from "ws";
import { Room, RoomManager, type RoomSource } from "./room";

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

  it("keeps a deleted shape as a tombstone: hasShape stays true, isLive turns false", () => {
    const room = new Room("room1");
    room.applyAndCache(createOp("s1", 100));
    expect(room.isLive("s1")).toBe(true);

    room.applyAndCache({
      type: "delete_shape",
      shapeId: "s1",
      roomId: "room1",
      hlc: { physical: 200, logical: 0, nodeId: "server" },
      opId: "del-s1",
    });
    expect(room.hasShape("s1")).toBe(true);
    expect(room.isLive("s1")).toBe(false);
  });

  it("reports false for both hasShape and isLive for a shape that never existed", () => {
    const room = new Room("room1");
    expect(room.hasShape("ghost")).toBe(false);
    expect(room.isLive("ghost")).toBe(false);
  });

  it("does not mistake Object.prototype members for shapes", () => {
    const room = new Room("room1");
    expect(room.hasShape("constructor")).toBe(false);
    expect(room.isLive("toString")).toBe(false);
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

describe("Room idle tracking and counters", () => {
  it("counts as idle from the moment it loads, if nobody has joined", () => {
    expect(new Room("room1", [], { now: 5000 }).idleSince).toBe(5000);
  });

  it("is not idle while anyone is connected, and idle again from when the last one leaves", () => {
    const room = new Room("room1", [], { now: 100 });
    const a = asWebSocket(fakeSocket());
    const b = asWebSocket(fakeSocket());
    room.addClient("a", a);
    room.addClient("b", b);
    expect(room.idleSince).toBeNull();
    expect(room.clientCount).toBe(2);

    room.removeClient(a, 900);
    expect(room.idleSince).toBeNull(); // b is still here
    room.removeClient(b, 1200);
    expect(room.idleSince).toBe(1200);
    expect(room.clientCount).toBe(0);
  });

  it("does not restart the idle clock when removing a socket that was never there", () => {
    const room = new Room("room1", [], { now: 100 });
    room.removeClient(asWebSocket(fakeSocket()), 9999);
    expect(room.idleSince).toBe(100);
  });

  it("counts every shape ever created, deleted ones included", () => {
    const room = new Room("room1");
    room.applyAndCache(createOp("s1", 100));
    room.applyAndCache(createOp("s2", 110));
    room.applyAndCache({
      type: "delete_shape",
      shapeId: "s1",
      roomId: "room1",
      hlc: { physical: 200, logical: 0, nodeId: "server" },
      opId: "del-s1",
    });
    expect(room.shapeCount()).toBe(2);
  });

  it("starts from a base state, then applies the ops after it", () => {
    const base = new Room("room1", [createOp("s1", 100)]).state;
    const room = new Room("room1", [createOp("s2", 200)], { baseState: base, latestSeq: 2, snapshotSeq: 1 });
    expect(Object.keys(room.state)).toEqual(["s1", "s2"]);
    expect(room.latestSeq).toBe(2);
    expect(room.snapshotSeq).toBe(1);
  });

  it("only ever moves its sequence markers forward", () => {
    const room = new Room("room1", [], { latestSeq: 10, snapshotSeq: 5 });
    room.noteAppended(7);
    room.noteSnapshotted(3);
    expect([room.latestSeq, room.snapshotSeq]).toEqual([10, 5]);
    room.noteAppended(11);
    room.noteSnapshotted(11);
    expect([room.latestSeq, room.snapshotSeq]).toEqual([11, 11]);
  });
});

/** A storage double that records how it was used. */
function fakeSource(
  options: {
    ops?: Op[];
    snapshot?: StoredSnapshot | null;
    loadSnapshotThrows?: boolean;
    saveThrows?: boolean;
  } = {},
) {
  const ops = options.ops ?? [];
  const saved: { roomId: string; seq: number; state: RoomState }[] = [];
  const source: RoomSource & { since: ReturnType<typeof vi.fn> } = {
    latestSeq: vi.fn(() => ops.length),
    loadSnapshot: vi.fn(() => {
      if (options.loadSnapshotThrows) throw new Error("unreadable");
      return options.snapshot ?? null;
    }),
    saveSnapshot: vi.fn((roomId: string, seq: number, state: RoomState) => {
      if (options.saveThrows) throw new Error("disk full");
      saved.push({ roomId, seq, state });
    }),
    since: vi.fn((_roomId: string, sinceSeq: number) =>
      ops.map((op, index) => ({ seq: index + 1, op })).filter((row) => row.seq > sinceSeq),
    ),
  };
  return { source, saved, ops };
}

const quiet = () => ({ warn: vi.fn(), info: vi.fn() });

describe("RoomManager loading", () => {
  it("lazily creates a room on first access, replaying the whole log when there is no snapshot", () => {
    const { source } = fakeSource({ ops: [createOp("s1", 100), createOp("s2", 200)] });
    const room = new RoomManager(source).get("room1");
    expect(source.since).toHaveBeenCalledWith("room1", 0);
    expect(Object.keys(room.state)).toEqual(["s1", "s2"]);
    expect(room.latestSeq).toBe(2);
    expect(room.snapshotSeq).toBe(0);
  });

  it("starts from a snapshot and replays only the ops after it", () => {
    const ops = [createOp("s1", 100), createOp("s2", 200), createOp("s3", 300)];
    const snapshot = { seq: 2, state: new Room("room1", ops.slice(0, 2)).state };
    const { source } = fakeSource({ ops, snapshot });

    const room = new RoomManager(source).get("room1");

    expect(source.since).toHaveBeenCalledWith("room1", 2); // the tail only
    expect(Object.keys(room.state)).toEqual(["s1", "s2", "s3"]);
    expect(room.snapshotSeq).toBe(2);
    expect(room.latestSeq).toBe(3);
  });

  it("ignores a snapshot that claims to be ahead of the log, and replays everything", () => {
    const ops = [createOp("s1", 100)];
    const bogus = { seq: 50, state: new Room("room1", [createOp("ghost", 1)]).state };
    const { source } = fakeSource({ ops, snapshot: bogus });

    const room = new RoomManager(source).get("room1");
    expect(source.since).toHaveBeenCalledWith("room1", 0);
    expect(Object.keys(room.state)).toEqual(["s1"]);
  });

  it("ignores an unreadable snapshot, with a warning, and replays everything", () => {
    const { source } = fakeSource({ ops: [createOp("s1", 100)], loadSnapshotThrows: true });
    const logger = quiet();
    const room = new RoomManager(source, { logger }).get("room1");
    expect(Object.keys(room.state)).toEqual(["s1"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("returns the same Room instance on repeated access without reloading", () => {
    const { source } = fakeSource();
    const manager = new RoomManager(source);
    expect(manager.get("room1")).toBe(manager.get("room1"));
    expect(source.latestSeq).toHaveBeenCalledTimes(1);
  });

  it("keeps separate rooms independent, and reports what it holds", () => {
    const manager = new RoomManager(fakeSource().source);
    const roomA = manager.get("roomA");
    const roomB = manager.get("roomB");
    roomA.applyAndCache(createOp("s1", 100));
    expect(roomB.state).toEqual({});
    expect(manager.size).toBe(2);
    expect(manager.has("roomA")).toBe(true);
    expect(manager.has("nope")).toBe(false);
  });
});

describe("RoomManager snapshots", () => {
  it("saves a snapshot once enough ops have been stored since the last one", () => {
    const { source, saved } = fakeSource();
    const manager = new RoomManager(source, { snapshotEvery: 3 });
    const room = manager.get("room1");

    room.applyAndCache(createOp("s1", 100));
    manager.noteAppended(room, 1);
    manager.noteAppended(room, 2);
    expect(saved).toEqual([]); // not yet

    room.applyAndCache(createOp("s2", 200));
    manager.noteAppended(room, 3);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ roomId: "room1", seq: 3 });
    expect(Object.keys(saved[0]!.state)).toEqual(["s1", "s2"]);
    expect(room.snapshotSeq).toBe(3);
  });

  it("counts the next interval from the last snapshot, not from zero", () => {
    const { source, saved } = fakeSource();
    const manager = new RoomManager(source, { snapshotEvery: 3 });
    const room = manager.get("room1");
    for (let seq = 1; seq <= 5; seq++) manager.noteAppended(room, seq);
    expect(saved.map((entry) => entry.seq)).toEqual([3]);
    manager.noteAppended(room, 6);
    expect(saved.map((entry) => entry.seq)).toEqual([3, 6]);
  });

  it("carries on, with a warning, when a snapshot cannot be saved, and tries again next time", () => {
    const { source } = fakeSource({ saveThrows: true });
    const logger = quiet();
    const manager = new RoomManager(source, { snapshotEvery: 2, logger });
    const room = manager.get("room1");
    expect(() => {
      manager.noteAppended(room, 1);
      manager.noteAppended(room, 2);
    }).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(room.snapshotSeq).toBe(0); // not marked as saved
    manager.noteAppended(room, 3);
    expect(logger.warn).toHaveBeenCalledTimes(2); // retried
  });

  it("snapshotAll saves only rooms that have ops past their last snapshot", () => {
    const { source, saved } = fakeSource();
    const manager = new RoomManager(source, { snapshotEvery: 1000 });
    const busy = manager.get("busy");
    manager.get("quiet");
    manager.noteAppended(busy, 4);

    manager.snapshotAll();
    expect(saved.map((entry) => entry.roomId)).toEqual(["busy"]);
    manager.snapshotAll();
    expect(saved).toHaveLength(1); // nothing new since
  });
});

describe("RoomManager eviction", () => {
  function setup(idleMs = 1000) {
    let now = 10_000;
    const { source, saved } = fakeSource();
    const manager = new RoomManager(source, { now: () => now });
    return { manager, saved, idleMs, advance: (ms: number) => (now += ms), clock: () => now };
  }

  it("drops a room that has been empty for the idle time", () => {
    const { manager, advance } = setup();
    manager.get("room1");
    advance(1000);
    expect(manager.evictIdle(1000)).toBe(1);
    expect(manager.has("room1")).toBe(false);
  });

  it("keeps a room that has been empty for less than the idle time", () => {
    const { manager, advance } = setup();
    manager.get("room1");
    advance(999);
    expect(manager.evictIdle(1000)).toBe(0);
    expect(manager.has("room1")).toBe(true);
  });

  it("never drops a room somebody is in, however long ago it loaded", () => {
    const { manager, advance } = setup();
    manager.get("room1").addClient("a", asWebSocket(fakeSocket()));
    advance(10_000_000);
    expect(manager.evictIdle(1000)).toBe(0);
  });

  it("starts the idle clock when the last person leaves, not when the room loaded", () => {
    const { manager, advance, clock } = setup();
    const room = manager.get("room1");
    const socket = asWebSocket(fakeSocket());
    room.addClient("a", socket);
    advance(5000);
    room.removeClient(socket, clock());
    advance(999);
    expect(manager.evictIdle(1000)).toBe(0);
    advance(1);
    expect(manager.evictIdle(1000)).toBe(1);
  });

  it("evicts only the idle rooms among several", () => {
    const { manager, advance } = setup();
    manager.get("idle");
    advance(2000);
    manager.get("fresh");
    expect(manager.evictIdle(1000)).toBe(1);
    expect(manager.has("idle")).toBe(false);
    expect(manager.has("fresh")).toBe(true);
  });

  it("saves a snapshot before dropping a room that has ops past its last one", () => {
    const { manager, saved, advance } = setup();
    const room = manager.get("room1");
    room.applyAndCache(createOp("s1", 100));
    manager.noteAppended(room, 1);
    advance(2000);
    manager.evictIdle(1000);
    expect(saved).toEqual([expect.objectContaining({ roomId: "room1", seq: 1 })]);
  });

  it("does not save a snapshot for a room with nothing new", () => {
    const { manager, saved, advance } = setup();
    manager.get("room1");
    advance(2000);
    manager.evictIdle(1000);
    expect(saved).toEqual([]);
  });

  it("makes room for a new room under a cap on how many are loaded", () => {
    const { manager, advance } = setup();
    manager.get("a");
    manager.get("b");
    expect(manager.size).toBe(2);
    advance(2000);
    manager.evictIdle(1000);
    expect(manager.size).toBe(0);
  });
});

/** A small seeded generator, so the randomized test below is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("loading from a snapshot gives exactly the state a full replay gives", () => {
  function randomOps(seed: number, count: number): Op[] {
    const random = seeded(seed);
    const ids = ["a", "b", "c", "d", "e", "constructor"];
    const ops: Op[] = [];
    for (let i = 0; i < count; i++) {
      const shapeId = ids[Math.floor(random() * ids.length)]!;
      const hlc = { physical: 1000 + i, logical: 0, nodeId: "server" };
      const opId = `op-${seed}-${i}`;
      const kind = random();
      if (kind < 0.3) {
        ops.push({
          type: "create_shape",
          shapeId,
          roomId: "room1",
          fields: { x: i, y: i, width: 10, height: 10, color: "#000" },
          hlc,
          opId,
        });
      } else if (kind < 0.85) {
        const changes = random() < 0.5 ? { x: i } : { y: i, color: "#fff" };
        ops.push({ type: "update_shape", shapeId, roomId: "room1", changes, hlc, opId });
      } else {
        ops.push({ type: "delete_shape", shapeId, roomId: "room1", hlc, opId });
      }
    }
    return ops;
  }

  it.each(Array.from({ length: 25 }, (_, i) => i + 1))("for random history %i", (seed) => {
    const log = new OpLog(":memory:");
    const ops = randomOps(seed, 60);
    const writer = new RoomManager(log, { snapshotEvery: 7 });
    const room = writer.get("room1");
    for (const op of ops) {
      const result = log.append("room1", op);
      if (result.status !== "appended") throw new Error("unexpected duplicate");
      room.applyAndCache(op);
      writer.noteAppended(room, result.seq);
    }

    const expected = applyOps({}, ops);
    expect(room.state).toEqual(expected);

    const reloaded = new RoomManager(log).get("room1");
    expect(reloaded.snapshotSeq).toBeGreaterThan(0); // a snapshot really was used
    expect(reloaded.snapshotSeq).toBeLessThan(reloaded.latestSeq + 1);
    expect(reloaded.state).toEqual(expected);
    expect(reloaded.latestSeq).toBe(ops.length);
    log.close();
  });
});
