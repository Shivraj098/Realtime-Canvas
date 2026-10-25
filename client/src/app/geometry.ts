/**
 * Rectangle maths for the canvas. Pure functions on plain numbers, so the
 * rules of drawing, hit-testing, moving and resizing are testable without a
 * browser. All coordinates are world coordinates, which in this version are
 * the same as canvas CSS pixels (there is no pan or zoom yet).
 */

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type HandleId = "nw" | "ne" | "sw" | "se";

/** Smallest width or height a shape can be given by dragging. */
export const MIN_SIZE = 8;
/** Side of a resize handle, which is also how close to it a pointer must be to grab it. */
export const HANDLE_SIZE = 10;
/** The wire protocol refuses coordinates beyond this (see server validation). */
export const WORLD_LIMIT = 1_000_000;

export const HANDLES: readonly HandleId[] = ["nw", "ne", "sw", "se"];

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

export function handlePositions(rect: Rect): Record<HandleId, Point> {
  return {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.width, y: rect.y },
    sw: { x: rect.x, y: rect.y + rect.height },
    se: { x: rect.x + rect.width, y: rect.y + rect.height },
  };
}

/** Which resize handle of `rect` is under `point`, if any. */
export function hitHandle(rect: Rect, point: Point, tolerance: number = HANDLE_SIZE): HandleId | null {
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
export function hitTest(shapes: readonly { id: string; rect: Rect }[], point: Point): string | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i]!;
    if (pointInRect(point, shape.rect)) return shape.id;
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
  handle: HandleId,
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
