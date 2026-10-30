import { isLinearKind, type ShapeKind } from "@realtime-canvas/shared";

/**
 * Shape maths for the canvas. Pure functions on plain numbers, so the
 * rules of drawing, hit-testing, moving and resizing are testable without a
 * browser. All coordinates are world coordinates, which in this version are
 * the same as canvas CSS pixels (there is no pan or zoom yet).
 *
 * A shape is described by its kind and a `Rect`. For a box (everything but
 * lines and arrows) the rect is what it looks like. For a LINEAR shape the
 * rect is a vector: `x`,`y` is the start and `width`,`height` is the way to the
 * end point, and either may be negative. `boundsOf` turns either into the plain
 * box that contains the shape.
 */

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
/** A box has four corner handles; a line or arrow has one at each end. */
export type HandleId = "nw" | "ne" | "sw" | "se" | "start" | "end";
export type BoxHandleId = "nw" | "ne" | "sw" | "se";
/** A shape as the interaction and hit-testing code see it. */
export type ShapeGeometry = { id: string; kind: ShapeKind; rect: Rect };

/** Smallest width or height a shape can be given by dragging. */
export const MIN_SIZE = 8;
/** Side of a resize handle, which is also how close to it a pointer must be to grab it. */
export const HANDLE_SIZE = 10;
/** The wire protocol refuses coordinates beyond this (see server validation). */
export const WORLD_LIMIT = 1_000_000;

export const HANDLES: readonly BoxHandleId[] = ["nw", "ne", "sw", "se"];
/** How close to a line or arrow a pointer must be to count as touching it. */
export const LINE_HIT_TOLERANCE = 8;
/** Shortest line or arrow a drag can make; a shorter one becomes the default length. */
export const MIN_LINE_LENGTH = 8;

export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** The rectangle spanned by two corners, whichever way the drag went. */
export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

export function handlePositions(rect: Rect): Record<BoxHandleId, Point> {
  return {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.width, y: rect.y },
    sw: { x: rect.x, y: rect.y + rect.height },
    se: { x: rect.x + rect.width, y: rect.y + rect.height },
  };
}

/** Which resize handle of `rect` is under `point`, if any. */
export function hitHandle(rect: Rect, point: Point, tolerance: number = HANDLE_SIZE): BoxHandleId | null {
  const positions = handlePositions(rect);
  for (const id of HANDLES) {
    const corner = positions[id];
    if (Math.abs(point.x - corner.x) <= tolerance && Math.abs(point.y - corner.y) <= tolerance) return id;
  }
  return null;
}

/**
 * The topmost shape under `point`. Shapes are given back to front (the
 * order they are drawn in), so the last match is the one on top.
 */
export function hitTest(
  shapes: readonly { id: string; rect: Rect; kind?: ShapeKind }[],
  point: Point,
): string | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i]!;
    if (hitShape(shape.kind ?? "rect", shape.rect, point)) return shape.id;
  }
  return null;
}

/**
 * Drags one corner of `start` by (dx, dy). The opposite corner stays where
 * it is. The rectangle is clamped to `minSize` instead of flipping over, so
 * dragging a handle past its opposite corner just stops at the minimum.
 */
export function resizeRect(
  start: Rect,
  handle: BoxHandleId,
  dx: number,
  dy: number,
  minSize: number = MIN_SIZE,
): Rect {
  const west = handle === "nw" || handle === "sw";
  const north = handle === "nw" || handle === "ne";

  const rawWidth = west ? start.width - dx : start.width + dx;
  const rawHeight = north ? start.height - dy : start.height + dy;
  const width = Math.max(minSize, rawWidth);
  const height = Math.max(minSize, rawHeight);

  return {
    x: west ? start.x + start.width - width : start.x,
    y: north ? start.y + start.height - height : start.y,
    width,
    height,
  };
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Whole pixels, inside the limits the server accepts. */
export function sanitizeRect(rect: Rect): Rect {
  return {
    x: clamp(Math.round(rect.x), -WORLD_LIMIT, WORLD_LIMIT),
    y: clamp(Math.round(rect.y), -WORLD_LIMIT, WORLD_LIMIT),
    width: clamp(Math.round(rect.width), 0, WORLD_LIMIT),
    height: clamp(Math.round(rect.height), 0, WORLD_LIMIT),
  };
}

/** The fields of `to` that differ from `from`: what an update op needs to carry. */
export function changedFields(from: Rect, to: Rect): Partial<Rect> {
  const changes: Partial<Rect> = {};
  if (from.x !== to.x) changes.x = to.x;
  if (from.y !== to.y) changes.y = to.y;
  if (from.width !== to.width) changes.width = to.width;
  if (from.height !== to.height) changes.height = to.height;
  return changes;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---- shapes of every kind ----------------------------------------------------

/** The two end points of a line or arrow. */
export function lineEnds(rect: Rect): { start: Point; end: Point } {
  return { start: { x: rect.x, y: rect.y }, end: { x: rect.x + rect.width, y: rect.y + rect.height } };
}

/** The plain box a shape occupies: the rect itself for a box, the box around both ends for a line or arrow. */
export function boundsOf(kind: ShapeKind, rect: Rect): Rect {
  if (!isLinearKind(kind)) return rect;
  const { start, end } = lineEnds(rect);
  return normalizeRect(start, end);
}

/** Shortest distance from `point` to the segment `a`-`b`. */
export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, a);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return distance(point, { x: a.x + t * dx, y: a.y + t * dy });
}

/** The three corners of a triangle shape: apex at the top centre, base along the bottom. */
export function trianglePoints(rect: Rect): [Point, Point, Point] {
  return [
    { x: rect.x + rect.width / 2, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

/** The four corners of a diamond: the middle of each side of its box. */
export function diamondPoints(rect: Rect): [Point, Point, Point, Point] {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return [
    { x: cx, y: rect.y },
    { x: rect.x + rect.width, y: cy },
    { x: cx, y: rect.y + rect.height },
    { x: rect.x, y: cy },
  ];
}

function pointInTriangle(p: Point, [a, b, c]: [Point, Point, Point]): boolean {
  const side = (u: Point, v: Point): number => (p.x - v.x) * (u.y - v.y) - (u.x - v.x) * (p.y - v.y);
  const d1 = side(a, b);
  const d2 = side(b, c);
  const d3 = side(c, a);
  const anyNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const anyPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(anyNegative && anyPositive);
}

/** Whether `point` is on the shape: inside its outline for a closed shape, near the stroke for a line or arrow. */
export function hitShape(kind: ShapeKind, rect: Rect, point: Point): boolean {
  switch (kind) {
    case "line":
    case "arrow": {
      const { start, end } = lineEnds(rect);
      return distanceToSegment(point, start, end) <= LINE_HIT_TOLERANCE;
    }
    case "ellipse": {
      if (rect.width === 0 || rect.height === 0) return false;
      const rx = rect.width / 2;
      const ry = rect.height / 2;
      const nx = (point.x - (rect.x + rx)) / rx;
      const ny = (point.y - (rect.y + ry)) / ry;
      return nx * nx + ny * ny <= 1;
    }
    case "diamond": {
      if (rect.width === 0 || rect.height === 0) return false;
      const nx = Math.abs(point.x - (rect.x + rect.width / 2)) / (rect.width / 2);
      const ny = Math.abs(point.y - (rect.y + rect.height / 2)) / (rect.height / 2);
      return nx + ny <= 1;
    }
    case "triangle":
      return rect.width > 0 && rect.height > 0 && pointInTriangle(point, trianglePoints(rect));
    case "rect":
    case "text":
      return pointInRect(point, rect);
  }
}

/** The handles a shape of this kind offers, and where they are. */
export function handlesFor(kind: ShapeKind, rect: Rect): { id: HandleId; point: Point }[] {
  if (isLinearKind(kind)) {
    const { start, end } = lineEnds(rect);
    return [
      { id: "start", point: start },
      { id: "end", point: end },
    ];
  }
  const positions = handlePositions(rect);
  return HANDLES.map((id) => ({ id, point: positions[id] }));
}

/** Which handle of the shape is under `point`, if any. The end of a line wins over its start when both are close. */
export function hitHandleFor(
  kind: ShapeKind,
  rect: Rect,
  point: Point,
  tolerance: number = HANDLE_SIZE,
): HandleId | null {
  const found = handlesFor(kind, rect)
    .reverse()
    .find(
      ({ point: corner }) =>
        Math.abs(point.x - corner.x) <= tolerance && Math.abs(point.y - corner.y) <= tolerance,
    );
  return found ? found.id : null;
}

/** Drags one end of a line or arrow by (dx, dy); the other end stays where it is. */
export function resizeLine(start: Rect, handle: "start" | "end", dx: number, dy: number): Rect {
  if (handle === "end") return { ...start, width: start.width + dx, height: start.height + dy };
  return { x: start.x + dx, y: start.y + dy, width: start.width - dx, height: start.height - dy };
}

/** Resizes by whichever handle was grabbed: a corner of a box, or an end of a line or arrow. */
export function resizeShape(start: Rect, handle: HandleId, dx: number, dy: number): Rect {
  if (handle === "start" || handle === "end") return resizeLine(start, handle, dx, dy);
  return resizeRect(start, handle, dx, dy);
}

/** Whole pixels, inside what the server accepts for this kind of shape (boxes never get a negative size). */
export function sanitizeShape(kind: ShapeKind, rect: Rect): Rect {
  if (!isLinearKind(kind)) return sanitizeRect(rect);
  return {
    x: clamp(Math.round(rect.x), -WORLD_LIMIT, WORLD_LIMIT),
    y: clamp(Math.round(rect.y), -WORLD_LIMIT, WORLD_LIMIT),
    width: clamp(Math.round(rect.width), -WORLD_LIMIT, WORLD_LIMIT),
    height: clamp(Math.round(rect.height), -WORLD_LIMIT, WORLD_LIMIT),
  };
}

/** The point on the same side of `origin` as `point` that makes a square (the Shift key while drawing a box). */
export function squareFrom(origin: Point, point: Point): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: origin.x + Math.sign(dx || 1) * side, y: origin.y + Math.sign(dy || 1) * side };
}

/** `point` moved to the nearest multiple of 45 degrees around `origin`, keeping its distance (Shift while drawing a line). */
export function snapAngle(origin: Point, point: Point): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
}

/** Of a move by (dx, dy), only the dominant axis (Shift while dragging a shape). */
export function lockAxis(dx: number, dy: number): { dx: number; dy: number } {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
}
