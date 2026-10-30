import { describe, expect, it } from "vitest";
import { applyOp, applyOps, getShape, isDeleted, liveShapes, type RoomState } from "./reconcile";
import type { HlcTimestamp } from "./hlc";
import type { Op, ShapeChanges } from "./protocol";

function hlc(physical: number, logical = 0, nodeId = "a"): HlcTimestamp {
  return { physical, logical, nodeId };
}

function createOp(shapeId: string, at: HlcTimestamp): Op {
  return {
    type: "create_shape",
    shapeId,
    roomId: "room1",
    kind: "rect",
    fields: { x: 0, y: 0, width: 10, height: 10, color: "#000", text: "" },
    hlc: at,
    opId: `create-${shapeId}`,
  };
}

function updateOp(shapeId: string, field: "x" | "color", value: number | string, at: HlcTimestamp): Op {
  return updateManyOp(shapeId, { [field]: value }, at);
}

function updateManyOp(shapeId: string, changes: ShapeChanges, at: HlcTimestamp): Op {
  return {
    type: "update_shape",
    shapeId,
    roomId: "room1",
    changes,
    hlc: at,
    opId: `update-${shapeId}-${Object.keys(changes).join("+")}-${at.physical}-${at.logical}-${at.nodeId}`,
  };
}

function deleteOp(shapeId: string, at: HlcTimestamp): Op {
  return {
    type: "delete_shape",
    shapeId,
    roomId: "room1",
    hlc: at,
    opId: `delete-${shapeId}-${at.physical}`,
  };
}

describe("applyOp: create_shape", () => {
  it("adds a new shape with every field stamped at the create's HLC", () => {
    const state = applyOp({}, createOp("s1", hlc(100)));
    expect(state.s1).toBeDefined();
    expect(state.s1!.x).toBe(0);
    expect(state.s1!.lastHlc.color).toEqual(hlc(100));
  });

  it("keeps the kind the shape was created with, and starts it with its text", () => {
    const op: Op = {
      ...(createOp("s1", hlc(100)) as Extract<Op, { type: "create_shape" }>),
      kind: "arrow",
      fields: { x: 5, y: 5, width: -40, height: 12, color: "#000", text: "go" },
    };
    const shape = applyOp({}, op).s1!;
    expect(shape.kind).toBe("arrow");
    expect(shape.width).toBe(-40);
    expect(shape.text).toBe("go");
    expect(shape.lastHlc.text).toEqual(hlc(100));
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

describe("applyOp: update_shape with several fields", () => {
  it("applies every field of one op under that op's single timestamp", () => {
    const state = applyOps({}, [
      createOp("s1", hlc(100)),
      updateManyOp("s1", { x: 5, y: 6, color: "#fff" }, hlc(200)),
    ]);
    expect(state.s1).toMatchObject({ x: 5, y: 6, color: "#fff", width: 10 });
    expect(state.s1!.lastHlc.x).toEqual(hlc(200));
    expect(state.s1!.lastHlc.y).toEqual(hlc(200));
    expect(state.s1!.lastHlc.width).toEqual(hlc(100)); // untouched field keeps its own timestamp
  });

  it("resolves each field independently: the fields that win apply, the ones that lose do not", () => {
    let state = applyOps({}, [createOp("s1", hlc(100)), updateOp("s1", "x", 77, hlc(300))]);
    state = applyOp(state, updateManyOp("s1", { x: 1, y: 2 }, hlc(200))); // loses on x, wins on y
    expect(state.s1).toMatchObject({ x: 77, y: 2 });
    expect(state.s1!.lastHlc.x).toEqual(hlc(300));
    expect(state.s1!.lastHlc.y).toEqual(hlc(200));
  });

  it("returns the same state reference when every field loses", () => {
    const state = applyOps({}, [createOp("s1", hlc(100)), updateManyOp("s1", { x: 1, y: 1 }, hlc(300))]);
    expect(applyOp(state, updateManyOp("s1", { x: 9, y: 9 }, hlc(200)))).toBe(state);
  });

  it("returns the same state reference for an update that changes nothing (empty changes)", () => {
    const state = applyOp({}, createOp("s1", hlc(100)));
    expect(applyOp(state, updateManyOp("s1", {}, hlc(200)))).toBe(state);
  });
});

describe("applyOp: delete_shape and tombstones", () => {
  it("marks the shape deleted with the delete's HLC instead of removing it", () => {
    const state = applyOps({}, [createOp("s1", hlc(100)), deleteOp("s1", hlc(200))]);
    expect(state.s1).toBeDefined();
    expect(isDeleted(state.s1!)).toBe(true);
    expect(state.s1!.deletedAt).toEqual(hlc(200));
  });

  it("is a no-op when deleting a shape that doesn't exist", () => {
    const state: RoomState = {};
    expect(applyOp(state, deleteOp("ghost", hlc(100)))).toBe(state);
  });

  it("is a no-op when deleting an already-deleted shape, keeping the first tombstone", () => {
    const deleted = applyOps({}, [createOp("s1", hlc(100)), deleteOp("s1", hlc(200))]);
    expect(applyOp(deleted, deleteOp("s1", hlc(300)))).toBe(deleted);
    expect(deleted.s1!.deletedAt).toEqual(hlc(200));
  });

  it("does not resurrect a deleted shape when an old create is replayed", () => {
    const create = createOp("s1", hlc(100));
    const deleted = applyOps({}, [create, deleteOp("s1", hlc(200))]);
    const replayed = applyOp(deleted, create);
    expect(replayed).toBe(deleted);
    expect(liveShapes(replayed)).toEqual({});
  });

  it("ignores an update to a deleted shape, even one with a later timestamp", () => {
    const deleted = applyOps({}, [createOp("s1", hlc(100)), deleteOp("s1", hlc(200))]);
    expect(applyOp(deleted, updateOp("s1", "x", 5, hlc(900)))).toBe(deleted);
  });

  it("liveShapes returns only shapes that are not tombstones", () => {
    const state = applyOps({}, [
      createOp("keep", hlc(100)),
      createOp("gone", hlc(110)),
      deleteOp("gone", hlc(120)),
    ]);
    expect(Object.keys(liveShapes(state))).toEqual(["keep"]);
  });
});

describe("shape ids that collide with Object.prototype members", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])("treats %s as an ordinary id", (id) => {
    let state = applyOp({}, createOp(id, hlc(100)));
    expect(getShape(state, id)).toBeDefined();
    state = applyOp(state, updateOp(id, "x", 5, hlc(200)));
    expect(getShape(state, id)!.x).toBe(5);
    state = applyOp(state, deleteOp(id, hlc(300)));
    expect(isDeleted(getShape(state, id)!)).toBe(true);
  });

  it("getShape does not find inherited members on a state that lacks them", () => {
    expect(getShape({}, "constructor")).toBeUndefined();
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

  it("converges for every delivery order of concurrent updates (different and same fields)", () => {
    const create = createOp("s1", hlc(100));
    const concurrent = [
      updateManyOp("s1", { x: 1, y: 1 }, hlc(200, 0, "clientA")),
      updateManyOp("s1", { x: 2, color: "#0f0" }, hlc(200, 0, "clientB")),
      updateManyOp("s1", { y: 3, width: 30 }, hlc(150, 5, "clientC")),
    ];
    const permutations = (items: Op[]): Op[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
          );

    const results = permutations(concurrent).map((order) => applyOps({}, [create, ...order]));
    expect(results).toHaveLength(6);
    for (const result of results) expect(result).toEqual(results[0]);
    // clientB wins x (same physical/logical as A, nodeId "clientB" > "clientA"); A wins y over C (physical 200 > 150).
    expect(results[0]!.s1).toMatchObject({ x: 2, y: 1, width: 30, color: "#0f0" });
  });

  it("converges on which shapes are visible when a delete races with updates", () => {
    const create = createOp("s1", hlc(100));
    const update = updateOp("s1", "x", 5, hlc(300)); // timestamp later than the delete
    const del = deleteOp("s1", hlc(200));
    const updateFirst = applyOps({}, [create, update, del]);
    const deleteFirst = applyOps({}, [create, del, update]);
    expect(liveShapes(updateFirst)).toEqual({});
    expect(liveShapes(deleteFirst)).toEqual({});
  });
});

describe("applyOp: text and kind", () => {
  it("resolves text as its own register: a concurrent recolor and relabel both survive", () => {
    const base = applyOp({}, createOp("s1", hlc(100)));
    const a = applyOp(base, updateManyOp("s1", { text: "hello" }, hlc(200, 0, "a")));
    const b = applyOp(a, updateManyOp("s1", { color: "#f00" }, hlc(150, 0, "b")));
    expect(b.s1).toMatchObject({ text: "hello", color: "#f00" });
  });

  it("lets the later of two same-field text edits win, in either delivery order", () => {
    const base = applyOp({}, createOp("s1", hlc(100)));
    const early = updateManyOp("s1", { text: "early" }, hlc(200, 0, "a"));
    const late = updateManyOp("s1", { text: "late" }, hlc(200, 1, "b"));
    expect(applyOps(base, [early, late]).s1!.text).toBe("late");
    expect(applyOps(base, [late, early]).s1!.text).toBe("late");
  });

  it("never changes a shape's kind through an update", () => {
    const base = applyOp({}, createOp("s1", hlc(100)));
    const sneaky = updateManyOp("s1", { kind: "arrow" } as unknown as ShapeChanges, hlc(200));
    expect(applyOp(base, sneaky)).toBe(base);
    expect(applyOp(base, sneaky).s1!.kind).toBe("rect");
  });
});
