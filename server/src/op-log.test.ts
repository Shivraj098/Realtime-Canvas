import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Op } from "@realtime-canvas/shared";
import { OpLog } from "./op-log";

function makeOp(shapeId: string, physical = 100, opId = `op-${shapeId}`): Op {
  return {
    type: "create_shape",
    shapeId,
    roomId: "room1",
    kind: "rect",
    fields: { x: 0, y: 0, width: 10, height: 10, color: "#000", text: "" },
    hlc: { physical, logical: 0, nodeId: "server" },
    opId,
  };
}

describe("OpLog", () => {
  it("assigns sequence numbers starting at 1, incrementing per room", () => {
    const log = new OpLog(":memory:");
    expect(log.append("room1", makeOp("s1"))).toEqual({ status: "appended", seq: 1 });
    expect(log.append("room1", makeOp("s2"))).toEqual({ status: "appended", seq: 2 });
    log.close();
  });

  it("keeps sequence numbers independent per room", () => {
    const log = new OpLog(":memory:");
    expect(log.append("room1", makeOp("s1"))).toEqual({ status: "appended", seq: 1 });
    expect(log.append("room2", makeOp("s1"))).toEqual({ status: "appended", seq: 1 });
    log.close();
  });

  it("latestSeq returns 0 for a room with no ops yet", () => {
    const log = new OpLog(":memory:");
    expect(log.latestSeq("empty-room")).toBe(0);
    log.close();
  });

  it("latestSeq reflects the highest appended sequence number", () => {
    const log = new OpLog(":memory:");
    log.append("room1", makeOp("s1"));
    log.append("room1", makeOp("s2"));
    expect(log.latestSeq("room1")).toBe(2);
    log.close();
  });

  it("since() returns only ops after the given sequence, in order", () => {
    const log = new OpLog(":memory:");
    log.append("room1", makeOp("s1"));
    log.append("room1", makeOp("s2"));
    log.append("room1", makeOp("s3"));

    const missed = log.since("room1", 1);
    expect(missed.map((row) => row.seq)).toEqual([2, 3]);
    expect(missed.map((row) => (row.op as { shapeId: string }).shapeId)).toEqual(["s2", "s3"]);
    log.close();
  });

  it("since() with sinceSeq 0 returns the full history - the fresh-join path", () => {
    const log = new OpLog(":memory:");
    log.append("room1", makeOp("s1"));
    log.append("room1", makeOp("s2"));
    expect(log.since("room1", 0)).toHaveLength(2);
    log.close();
  });

  it("since() for a room with no ops returns an empty array, not an error", () => {
    const log = new OpLog(":memory:");
    expect(log.since("nonexistent-room", 0)).toEqual([]);
    log.close();
  });

  it("round-trips an op through the JSON column unchanged", () => {
    const log = new OpLog(":memory:");
    const original = makeOp("s1", 12345);
    log.append("room1", original);
    const [row] = log.since("room1", 0);
    expect(row!.op).toEqual(original);
    log.close();
  });
});

describe("OpLog idempotency", () => {
  it("reports a repeated opId in the same room as a duplicate and stores nothing", () => {
    const log = new OpLog(":memory:");
    log.append("room1", makeOp("s1", 100, "same-op"));
    expect(log.append("room1", makeOp("s1", 999, "same-op")).status).toBe("duplicate");
    expect(log.since("room1", 0)).toHaveLength(1);
    log.close();
  });

  it("returns the ORIGINAL stored op and sequence number for a duplicate, not the retried payload", () => {
    const log = new OpLog(":memory:");
    log.append("room1", makeOp("other"));
    const original = makeOp("s1", 100, "same-op");
    log.append("room1", original);
    expect(log.append("room1", makeOp("s1", 999, "same-op"))).toEqual({
      status: "duplicate",
      seq: 2,
      op: original,
    });
    log.close();
  });

  it("does not consume a sequence number for a duplicate", () => {
    const log = new OpLog(":memory:");
    log.append("room1", makeOp("s1", 100, "same-op"));
    log.append("room1", makeOp("s1", 100, "same-op"));
    expect(log.append("room1", makeOp("s2"))).toEqual({ status: "appended", seq: 2 });
    log.close();
  });

  it("allows the same opId in different rooms", () => {
    const log = new OpLog(":memory:");
    expect(log.append("room1", makeOp("s1", 100, "shared-id")).status).toBe("appended");
    expect(log.append("room2", makeOp("s1", 100, "shared-id")).status).toBe("appended");
    log.close();
  });
});

describe("OpLog.find", () => {
  it("returns the stored op and its sequence number for a known opId", () => {
    const log = new OpLog(":memory:");
    log.append("room1", makeOp("s1"));
    const op = makeOp("s2", 200);
    log.append("room1", op);
    expect(log.find("room1", op.opId)).toEqual({ seq: 2, op });
    log.close();
  });

  it("returns null for an unknown opId, and for an opId that only exists in another room", () => {
    const log = new OpLog(":memory:");
    log.append("room1", makeOp("s1", 100, "only-in-room1"));
    expect(log.find("room1", "nope")).toBeNull();
    expect(log.find("room2", "only-in-room1")).toBeNull();
    log.close();
  });
});

describe("OpLog durability", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("keeps ops, sequence numbers, and dedupe state across a close and reopen", () => {
    dir = mkdtempSync(join(tmpdir(), "op-log-"));
    const path = join(dir, "ops.sqlite");

    const first = new OpLog(path);
    first.append("room1", makeOp("s1"));
    first.append("room1", makeOp("s2"));
    first.close();

    const reopened = new OpLog(path);
    expect(reopened.latestSeq("room1")).toBe(2);
    expect(reopened.since("room1", 0)).toHaveLength(2);
    expect(reopened.append("room1", makeOp("s1"))).toMatchObject({ status: "duplicate", seq: 1 });
    expect(reopened.append("room1", makeOp("s3"))).toEqual({ status: "appended", seq: 3 });
    reopened.close();
  });
});

describe("OpLog snapshots", () => {
  const state = {
    s1: { kind: "rect", x: 1, y: 2, width: 3, height: 4, color: "#fff", text: "", lastHlc: { text: {} } },
  } as unknown as import("@realtime-canvas/shared").RoomState;

  it("has no snapshot until one is saved", () => {
    const log = new OpLog(":memory:");
    expect(log.loadSnapshot("room1")).toBeNull();
    log.close();
  });

  it("returns what was saved", () => {
    const log = new OpLog(":memory:");
    log.saveSnapshot("room1", 12, state);
    expect(log.loadSnapshot("room1")).toEqual({ seq: 12, state });
    log.close();
  });

  it("keeps only the newest snapshot of a room", () => {
    const log = new OpLog(":memory:");
    log.saveSnapshot("room1", 5, {});
    log.saveSnapshot("room1", 9, state);
    expect(log.loadSnapshot("room1")).toEqual({ seq: 9, state });
    log.close();
  });

  it("keeps rooms apart", () => {
    const log = new OpLog(":memory:");
    log.saveSnapshot("a", 1, state);
    expect(log.loadSnapshot("b")).toBeNull();
    log.close();
  });

  it("survives close and reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "oplog-"));
    try {
      const path = join(dir, "ops.sqlite");
      const first = new OpLog(path);
      first.saveSnapshot("room1", 3, state);
      first.close();
      const second = new OpLog(path);
      expect(second.loadSnapshot("room1")).toEqual({ seq: 3, state });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OpLog.totalOps", () => {
  it("counts every stored op across rooms", () => {
    const log = new OpLog(":memory:");
    expect(log.totalOps()).toBe(0);
    log.append("a", makeOp("s1", 100, "o1"));
    log.append("a", makeOp("s2", 101, "o2"));
    log.append("b", makeOp("s1", 102, "o3"));
    expect(log.totalOps()).toBe(3);
    log.close();
  });

  it("does not count a duplicate", () => {
    const log = new OpLog(":memory:");
    log.append("a", makeOp("s1", 100, "same"));
    log.append("a", makeOp("s1", 999, "same"));
    expect(log.totalOps()).toBe(1);
    log.close();
  });

  it("is restored from the database when it is reopened", () => {
    const dir = mkdtempSync(join(tmpdir(), "oplog-"));
    try {
      const path = join(dir, "ops.sqlite");
      const first = new OpLog(path);
      first.append("a", makeOp("s1", 100, "o1"));
      first.append("a", makeOp("s2", 101, "o2"));
      first.close();
      const second = new OpLog(path);
      expect(second.totalOps()).toBe(2);
      second.append("a", makeOp("s3", 102, "o3"));
      expect(second.totalOps()).toBe(3);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OpLog.ping", () => {
  it("succeeds on a working database and throws once it is closed", () => {
    const log = new OpLog(":memory:");
    expect(() => log.ping()).not.toThrow();
    log.close();
    expect(() => log.ping()).toThrow();
  });
});

describe("OpLog: data written before shapes had a kind and a text", () => {
  const hlc = { physical: 5, logical: 0, nodeId: "server" };

  it("reads an old create_shape op as a rectangle with no label", () => {
    const log = new OpLog(":memory:");
    // Written the way protocol 2 stored it: no `kind`, no `fields.text`.
    const legacy = {
      type: "create_shape",
      shapeId: "old",
      roomId: "room1",
      fields: { x: 1, y: 2, width: 3, height: 4, color: "#fff" },
      hlc,
      opId: "old-op",
    };
    log.append("room1", legacy as unknown as Op);
    const [stored] = log.since("room1", 0);
    expect(stored!.op).toMatchObject({ kind: "rect", fields: { text: "", x: 1 } });
    expect(log.find("room1", "old-op")!.op).toMatchObject({ kind: "rect" });
    log.close();
  });

  it("reads an old snapshot the same way, and never overwrites a kind that is already there", () => {
    const log = new OpLog(":memory:");
    const shape = (extra: object) => ({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      color: "#fff",
      lastHlc: { x: hlc, y: hlc, width: hlc, height: hlc, color: hlc },
      ...extra,
    });
    log.saveSnapshot("room1", 3, { old: shape({}), current: shape({ kind: "arrow", text: "hi" }) } as never);
    const { state } = log.loadSnapshot("room1")!;
    expect(state.old).toMatchObject({ kind: "rect", text: "" });
    expect(state.old!.lastHlc.text).toEqual(hlc);
    expect(state.current).toMatchObject({ kind: "arrow", text: "hi" });
    log.close();
  });
});
