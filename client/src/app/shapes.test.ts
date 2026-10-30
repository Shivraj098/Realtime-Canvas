import { describe, expect, it } from "vitest";
import {
  boundsOf,
  distanceToSegment,
  handlesFor,
  hitHandleFor,
  hitShape,
  hitTest,
  lockAxis,
  resizeLine,
  resizeShape,
  sanitizeShape,
  snapAngle,
  squareFrom,
  type Rect,
} from "./geometry";

const box: Rect = { x: 100, y: 100, width: 100, height: 60 };
// From (50, 50) to (150, 100): points down and to the right.
const down: Rect = { x: 50, y: 50, width: 100, height: 50 };
// From (150, 100) back to (50, 50): the same line, drawn the other way.
const up: Rect = { x: 150, y: 100, width: -100, height: -50 };

describe("hitShape: closed shapes are hit inside their outline, not their box", () => {
  it("ellipse: the centre is in, the corner of its box is out", () => {
    expect(hitShape("ellipse", box, { x: 150, y: 130 })).toBe(true);
    expect(hitShape("ellipse", box, { x: 101, y: 101 })).toBe(false);
    expect(hitShape("ellipse", box, { x: 101, y: 130 })).toBe(true);
  });

  it("diamond: the middle is in, a corner of its box is out", () => {
    expect(hitShape("diamond", box, { x: 150, y: 130 })).toBe(true);
    expect(hitShape("diamond", box, { x: 105, y: 105 })).toBe(false);
    expect(hitShape("diamond", box, { x: 150, y: 102 })).toBe(true);
  });

  it("triangle: the base is wide and the apex is narrow", () => {
    expect(hitShape("triangle", box, { x: 150, y: 110 })).toBe(true);
    expect(hitShape("triangle", box, { x: 105, y: 110 })).toBe(false);
    expect(hitShape("triangle", box, { x: 105, y: 158 })).toBe(true);
  });

  it("rect and text: the whole box", () => {
    expect(hitShape("rect", box, { x: 101, y: 101 })).toBe(true);
    expect(hitShape("text", box, { x: 199, y: 159 })).toBe(true);
    expect(hitShape("rect", box, { x: 201, y: 130 })).toBe(false);
  });

  it("never hits a closed shape with no area", () => {
    const flat = { x: 10, y: 10, width: 0, height: 0 };
    expect(hitShape("ellipse", flat, { x: 10, y: 10 })).toBe(false);
    expect(hitShape("diamond", flat, { x: 10, y: 10 })).toBe(false);
    expect(hitShape("triangle", flat, { x: 10, y: 10 })).toBe(false);
  });
});

describe("lines and arrows", () => {
  it.each(["line", "arrow"] as const)("a %s is hit near its stroke only, whichever way it points", (kind) => {
    for (const rect of [down, up]) {
      expect(hitShape(kind, rect, { x: 100, y: 75 })).toBe(true);
      expect(hitShape(kind, rect, { x: 100, y: 79 })).toBe(true);
      expect(hitShape(kind, rect, { x: 100, y: 95 })).toBe(false);
      expect(hitShape(kind, rect, { x: 200, y: 75 })).toBe(false);
    }
  });

  it("measures distance to the nearest point of the segment, including past its ends", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  it("boundsOf turns a vector into the box around both ends, and leaves a box alone", () => {
    expect(boundsOf("arrow", up)).toEqual({ x: 50, y: 50, width: 100, height: 50 });
    expect(boundsOf("line", down)).toEqual({ x: 50, y: 50, width: 100, height: 50 });
    expect(boundsOf("rect", box)).toBe(box);
  });

  it("offers a handle at each end instead of four corners", () => {
    expect(handlesFor("arrow", up)).toEqual([
      { id: "start", point: { x: 150, y: 100 } },
      { id: "end", point: { x: 50, y: 50 } },
    ]);
    expect(handlesFor("rect", box).map((h) => h.id)).toEqual(["nw", "ne", "sw", "se"]);
  });

  it("finds an end handle, and prefers the end when both ends coincide", () => {
    expect(hitHandleFor("arrow", down, { x: 52, y: 51 })).toBe("start");
    expect(hitHandleFor("arrow", down, { x: 149, y: 99 })).toBe("end");
    expect(hitHandleFor("arrow", down, { x: 100, y: 75 })).toBeNull();
    const point = { x: 10, y: 10, width: 0, height: 0 };
    expect(hitHandleFor("line", point, { x: 10, y: 10 })).toBe("end");
  });

  it("dragging an end moves only that end", () => {
    expect(resizeLine(down, "end", 10, -20)).toEqual({ x: 50, y: 50, width: 110, height: 30 });
    expect(resizeLine(down, "start", 10, -20)).toEqual({ x: 60, y: 30, width: 90, height: 70 });
    // The far end really did not move.
    const moved = resizeLine(down, "start", 10, -20);
    expect({ x: moved.x + moved.width, y: moved.y + moved.height }).toEqual({ x: 150, y: 100 });
  });

  it("dragging an end past the other end flips the line instead of clamping it", () => {
    const flipped = resizeShape(down, "end", -200, -100);
    expect(flipped).toEqual({ x: 50, y: 50, width: -100, height: -50 });
  });

  it("resizeShape routes a box handle to the box rules", () => {
    expect(resizeShape(box, "se", 20, 10)).toEqual({ x: 100, y: 100, width: 120, height: 70 });
  });
});

describe("hitTest with kinds", () => {
  it("looks through the empty corner of an ellipse to the shape behind it", () => {
    const shapes = [
      { id: "back", kind: "rect" as const, rect: box },
      { id: "front", kind: "ellipse" as const, rect: box },
    ];
    expect(hitTest(shapes, { x: 150, y: 130 })).toBe("front");
    expect(hitTest(shapes, { x: 101, y: 101 })).toBe("back");
  });

  it("treats a shape given no kind as a rectangle", () => {
    expect(hitTest([{ id: "a", rect: box }], { x: 101, y: 101 })).toBe("a");
  });
});

describe("sanitizeShape", () => {
  it("rounds a line's vector but keeps its sign", () => {
    expect(sanitizeShape("line", { x: 1.4, y: 2.6, width: -10.5, height: -0.4 })).toEqual({
      x: 1,
      y: 3,
      width: -10,
      height: -0,
    });
  });

  it("clamps a line to the world limit in both directions", () => {
    const rect = sanitizeShape("arrow", { x: 0, y: 0, width: -5e9, height: 5e9 });
    expect(rect.width).toBe(-1_000_000);
    expect(rect.height).toBe(1_000_000);
  });

  it("never gives a box a negative size", () => {
    const rect = sanitizeShape("ellipse", { x: 0, y: 0, width: -5, height: -5 });
    expect(rect.width).toBeGreaterThanOrEqual(0);
    expect(rect.height).toBeGreaterThanOrEqual(0);
  });
});

describe("constraints (the Shift key)", () => {
  it("squareFrom makes a square in whichever direction the pointer went", () => {
    expect(squareFrom({ x: 0, y: 0 }, { x: 30, y: 10 })).toEqual({ x: 30, y: 30 });
    expect(squareFrom({ x: 0, y: 0 }, { x: -10, y: -40 })).toEqual({ x: -40, y: -40 });
    expect(squareFrom({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });

  it("snapAngle keeps the length and rounds the direction to 45 degrees", () => {
    const horizontal = snapAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
    expect(horizontal.y).toBeCloseTo(0);
    expect(horizontal.x).toBeCloseTo(Math.hypot(100, 10));
    const diagonal = snapAngle({ x: 0, y: 0 }, { x: 50, y: 60 });
    expect(diagonal.x).toBeCloseTo(diagonal.y);
    expect(snapAngle({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual({ x: 3, y: 3 });
  });

  it("lockAxis keeps the larger of the two movements", () => {
    expect(lockAxis(10, -3)).toEqual({ dx: 10, dy: 0 });
    expect(lockAxis(2, -9)).toEqual({ dx: 0, dy: -9 });
  });
});
