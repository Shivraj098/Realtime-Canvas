import { describe, expect, it } from "vitest";
import { applyOp, applyOps, type RoomState } from "./reconcile";
import type { HlcTimestamp } from "./hlc";
import type { Op, FieldChange } from "./protocol";

function hlc(physical: number, logical = 0, nodeId = "a"): HlcTimestamp {
  return { physical, logical, nodeId };
}

function createOp(shapeId: string, at: HlcTimestamp): Op {
  return {
    type: "create_shape",
    shapeId,
    roomId: "room1",
    fields: { x: 0, y: 0, width: 10, height: 10, color: "#000" },
    hlc: at,
    opId: `create-${shapeId}`,
  };
}

function updateOp(shapeId: string, field: "x" | "color", value: number | string, at: HlcTimestamp): Op {
  const change = { field, value } as FieldChange;
  return {
    type: "update_shape",
    shapeId,
    roomId: "room1",
    change,
    hlc: at,
    opId: `update-${shapeId}-${field}-${at.physical}-${at.logical}`,
  };
}

describe("applyOp: create_shape", () => {
  it("adds a new shape with every field stamped at the create's HLC", () => {
    const state = applyOp({}, createOp("s1", hlc(100)));
    expect(state.s1).toBeDefined();
    expect(state.s1!.x).toBe(0);
    expect(state.s1!.lastHlc.color).toEqual(hlc(100));
  });

  it("is a no-op when the shapeId already exists (duplicate/replayed create)", () => {
    const first = applyOp({}, createOp("s1", hlc(100)));
    const second = applyOp(first, createOp("s1", hlc(200)));
    expect(second).toBe(first); // same reference: genuinely a no-op, not just equal
  });
});

describe("applyOp: update_shape conflict resolution", () => {
  it("applies an update when its HLC is causally later than the field's last write", () => {
    let state: RoomState = applyOp({}, createOp("s1", hlc(100)));
    state = applyOp(state, updateOp("s1", "x", 50, hlc(200)));
    expect(state.s1!.x).toBe(50);
  });

  it("drops an update when its HLC is earlier than the field's last write (the actual conflict case)", () => {
    let state: RoomState = applyOp({}, createOp("s1", hlc(100)));
    state = applyOp(state, updateOp("s1", "x", 50, hlc(300))); // wins
    const beforeLosingUpdate = state;
    state = applyOp(state, updateOp("s1", "x", 999, hlc(150))); // arrives late, loses
    expect(state.s1!.x).toBe(50);
    expect(state).toBe(beforeLosingUpdate); // no-op, same reference
  });

  it("drops an update whose HLC exactly ties the last write (equal is not later)", () => {
    let state: RoomState = applyOp({}, createOp("s1", hlc(100)));
    const tieHlc = hlc(200);
    state = applyOp(state, updateOp("s1", "x", 50, tieHlc));
    const afterFirst = state;
    state = applyOp(state, updateOp("s1", "x", 999, tieHlc));
    expect(state.s1!.x).toBe(50);
    expect(state).toBe(afterFirst);
  });

  it("lets concurrent updates to different fields of the same shape both survive", () => {
    let state: RoomState = applyOp({}, createOp("s1", hlc(100)));
    // Two "concurrent" edits at the same physical time, different nodes,
    // touching different fields - both must be kept.
    state = applyOp(state, updateOp("s1", "x", 42, hlc(200, 0, "clientA")));
    state = applyOp(state, updateOp("s1", "color", "#f00", hlc(200, 0, "clientB")));
    expect(state.s1!.x).toBe(42);
    expect(state.s1!.color).toBe("#f00");
  });

  it("is a no-op for an update targeting a shape that doesn't exist (e.g. already deleted)", () => {
    const state = applyOp({}, updateOp("ghost", "x", 1, hlc(100)));
    expect(state).toEqual({});
  });
});

describe("applyOp: delete_shape", () => {
  it("removes the shape from state", () => {
    let state: RoomState = applyOp({}, createOp("s1", hlc(100)));
    state = applyOp(state, {
      type: "delete_shape",
      shapeId: "s1",
      roomId: "room1",
      hlc: hlc(200),
      opId: "del-1",
    });
    expect(state.s1).toBeUndefined();
  });

  it("is a no-op when deleting a shape that doesn't exist", () => {
    const state: RoomState = {};
    const next = applyOp(state, {
      type: "delete_shape",
      shapeId: "ghost",
      roomId: "room1",
      hlc: hlc(100),
      opId: "del-1",
    });
    expect(next).toBe(state);
  });
});

describe("convergence: the actual CRDT property", () => {
  it("produces the same final state regardless of the order concurrent (causally-independent) ops are applied in", () => {
    // These two updates are concurrent - neither depends on the other -
    // so their relative order must not affect the outcome. The create
    // is applied first for both because update_shape requires the shape
    // to already exist (see the note on applyOp above); that ordering
    // constraint is about causal dependency, not about these two updates
    // racing each other, which is the actual property under test here.
    const create = createOp("s1", hlc(100));
    const updateX = updateOp("s1", "x", 10, hlc(200, 0, "clientA"));
    const updateColor = updateOp("s1", "color", "#00f", hlc(150, 0, "clientB"));

    const orderA = applyOps({}, [create, updateX, updateColor]);
    const orderB = applyOps({}, [create, updateColor, updateX]);

    expect(orderA).toEqual(orderB);
  });

  it("drops an update that arrives before its shape's create - a documented limitation, not a bug", () => {
    // applyOp is NOT tolerant of arbitrary out-of-order delivery for
    // causally dependent ops (create must precede update for the same
    // shape). This system relies on the server's op log to guarantee
    // ordered delivery instead of making applyOp itself order-independent
    // - a real general-purpose CRDT would buffer or use tombstones to
    // handle this, which this project deliberately scopes out. This test
    // exists to make that boundary explicit and regression-tested.
    const create = createOp("s1", hlc(100));
    const update = updateOp("s1", "x", 999, hlc(50)); // earlier HLC, arrives first
    const outOfOrder = applyOps({}, [update, create]);
    expect(outOfOrder.s1!.x).toBe(0); // update was silently dropped, not merged
  });

  it("converges correctly even when a losing update is replayed multiple times", () => {
    const ops: Op[] = [
      createOp("s1", hlc(100)),
      updateOp("s1", "x", 999, hlc(150)), // will lose
      updateOp("s1", "x", 50, hlc(300)), // will win
    ];
    // Simulate the "losing" op being redelivered (e.g. a naive retry) -
    // final state must be unaffected.
    const withDuplicateReplay = applyOps(applyOps({}, ops), [ops[1]!]);
    const withoutReplay = applyOps({}, ops);
    expect(withDuplicateReplay).toEqual(withoutReplay);
    expect(withDuplicateReplay.s1!.x).toBe(50);
  });
});