import { describe, expect, it } from "vitest";
import {
  changedFields,
  distance,
  handlePositions,
  hitHandle,
  hitTest,
  MIN_SIZE,
  moveRect,
  normalizeRect,
  pointInRect,
  resizeRect,
  sanitizeRect,
  WORLD_LIMIT,
  type Rect,
} from "./geometry";

const rect: Rect = { x: 100, y: 100, width: 200, height: 100 };

describe("pointInRect", () => {
  it.each([
    ["inside", { x: 150, y: 150 }, true],
    ["on the top-left corner", { x: 100, y: 100 }, true],
    ["on the bottom-right corner", { x: 300, y: 200 }, true],
    ["just left", { x: 99, y: 150 }, false],
    ["just right", { x: 301, y: 150 }, false],
    ["just above", { x: 150, y: 99 }, false],
    ["just below", { x: 150, y: 201 }, false],
  ])("%s", (_name, point, expected) => {
    expect(pointInRect(point, rect)).toBe(expected);
  });
});

describe("normalizeRect", () => {
  it("is the same whichever diagonal the drag went along", () => {
    const expected = { x: 10, y: 20, width: 30, height: 40 };
    expect(normalizeRect({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected);
    expect(normalizeRect({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected);
    expect(normalizeRect({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected);
    expect(normalizeRect({ x: 10, y: 60 }, { x: 40, y: 20 })).toEqual(expected);
  });
});

describe("hitTest", () => {
  const shapes = [
    { id: "back", rect: { x: 0, y: 0, width: 100, height: 100 } },
    { id: "front", rect: { x: 50, y: 50, width: 100, height: 100 } },
  ];

  it("returns the topmost shape where shapes overlap", () => {
    expect(hitTest(shapes, { x: 75, y: 75 })).toBe("front");
  });

  it("returns a shape below when the top one does not cover the point", () => {
    expect(hitTest(shapes, { x: 10, y: 10 })).toBe("back");
  });

  it("returns null over empty space and for no shapes", () => {
    expect(hitTest(shapes, { x: 500, y: 500 })).toBeNull();
    expect(hitTest([], { x: 1, y: 1 })).toBeNull();
  });
});

describe("handles", () => {
  it("places a handle on each corner", () => {
    expect(handlePositions(rect)).toEqual({
      nw: { x: 100, y: 100 },
      ne: { x: 300, y: 100 },
      sw: { x: 100, y: 200 },
      se: { x: 300, y: 200 },
    });
  });

  it.each([
    ["nw", { x: 98, y: 103 }],
    ["ne", { x: 305, y: 96 }],
    ["sw", { x: 100, y: 205 }],
    ["se", { x: 296, y: 204 }],
  ])("grabs %s from nearby", (id, point) => {
    expect(hitHandle(rect, point)).toBe(id);
  });

  it("grabs nothing from far away in ANY direction, not just beyond the corner", () => {
    for (const point of [
      { x: 0, y: 100 }, // far left of the north-west handle
      { x: 100, y: 0 }, // far above it
      { x: 600, y: 200 }, // far right of the south-east handle
      { x: 300, y: 600 }, // far below it
      { x: -500, y: -500 },
    ]) {
      expect(hitHandle(rect, point)).toBeNull();
    }
  });

  it("grabs nothing from the middle or from far outside", () => {
    expect(hitHandle(rect, { x: 200, y: 150 })).toBeNull();
    expect(hitHandle(rect, { x: 400, y: 400 })).toBeNull();
  });
});

describe("moveRect", () => {
  it("shifts position and keeps size", () => {
    expect(moveRect(rect, 5, -7)).toEqual({ x: 105, y: 93, width: 200, height: 100 });
  });
});

describe("resizeRect", () => {
  it("drags the south-east corner, keeping the north-west corner fixed", () => {
    expect(resizeRect(rect, "se", 20, 10)).toEqual({ x: 100, y: 100, width: 220, height: 110 });
  });

  it("drags the north-west corner, keeping the south-east corner fixed", () => {
    expect(resizeRect(rect, "nw", 20, 10)).toEqual({ x: 120, y: 110, width: 180, height: 90 });
  });

  it("drags the north-east corner, keeping the south-west corner fixed", () => {
    expect(resizeRect(rect, "ne", 20, -10)).toEqual({ x: 100, y: 90, width: 220, height: 110 });
  });

  it("drags the south-west corner, keeping the north-east corner fixed", () => {
    expect(resizeRect(rect, "sw", -20, 10)).toEqual({ x: 80, y: 100, width: 220, height: 110 });
  });

  it("stops at the minimum size instead of flipping over", () => {
    const shrunk = resizeRect(rect, "se", -500, -500);
    expect(shrunk).toEqual({ x: 100, y: 100, width: MIN_SIZE, height: MIN_SIZE });
  });

  it("keeps the opposite corner fixed even at the minimum", () => {
    const shrunk = resizeRect(rect, "nw", 500, 500);
    expect(shrunk.x + shrunk.width).toBe(300);
    expect(shrunk.y + shrunk.height).toBe(200);
    expect(shrunk.width).toBe(MIN_SIZE);
  });

  it("is a no-op for a zero drag", () => {
    for (const handle of ["nw", "ne", "sw", "se"] as const) {
      expect(resizeRect(rect, handle, 0, 0)).toEqual(rect);
    }
  });
});

describe("sanitizeRect", () => {
  it("rounds to whole pixels", () => {
    expect(sanitizeRect({ x: 1.4, y: 1.6, width: 10.5, height: 9.49 })).toEqual({
      x: 1,
      y: 2,
      width: 11,
      height: 9,
    });
  });

  it("keeps values inside what the server accepts", () => {
    const clamped = sanitizeRect({ x: -5e9, y: 5e9, width: -3, height: 9e9 });
    expect(clamped).toEqual({ x: -WORLD_LIMIT, y: WORLD_LIMIT, width: 0, height: WORLD_LIMIT });
  });
});

describe("changedFields", () => {
  it("lists only what differs", () => {
    expect(changedFields(rect, { ...rect, x: 101 })).toEqual({ x: 101 });
    expect(changedFields(rect, { ...rect, width: 1, height: 2 })).toEqual({ width: 1, height: 2 });
  });

  it("is empty when nothing changed", () => {
    expect(changedFields(rect, { ...rect })).toEqual({});
  });
});

describe("distance", () => {
  it("is the straight-line distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
