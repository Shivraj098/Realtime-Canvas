import { isLinearKind, type ShapeKind } from "@realtime-canvas/shared";
import {
  changedFields,
  distance,
  hitHandleFor,
  hitTest,
  lineEnds,
  lockAxis,
  MIN_LINE_LENGTH,
  MIN_SIZE,
  moveRect,
  normalizeRect,
  resizeShape,
  sanitizeShape,
  snapAngle,
  squareFrom,
  type HandleId,
  type Point,
  type Rect,
  type ShapeGeometry,
} from "./geometry";
import { clampTextWidth, DEFAULT_TEXT_WIDTH, minTextHeight } from "./text-layout";

/**
 * What a mouse, pen or finger is doing on the canvas, as a state machine.
 *
 * The functions take the current state and the pointer position and return
 * the next state plus the effects the caller must carry out (send an op,
 * send a preview, change the selection). Nothing here touches the DOM or the
 * network, so every rule - "a click selects", "dragging below the threshold
 * is still a click", "a resize stops at the minimum size" - is a plain test.
 *
 * Two kinds of effect matter for the protocol:
 *  - `preview` fires on EVERY pointer move while dragging; the caller
 *    throttles it. It is ephemeral and never becomes an op.
 *  - `create` / `update` fire once, on release. One gesture is one op, however
 *    long the drag was. That is what keeps the op log small.
 *
 * `constrain` is the Shift key: it makes a drawn box square, snaps a line to
 * a multiple of 45 degrees, and locks a drag to one axis.
 */

/** Everything the toolbar can have selected: the pointer, or one kind of shape to draw. */
export type Tool = "select" | ShapeKind;

export type Interaction =
  | { kind: "idle" }
  | { kind: "creating"; shape: ShapeKind; origin: Point; current: Point; constrain: boolean }
  | {
      kind: "moving";
      shapeId: string;
      shape: ShapeKind;
      start: Rect;
      origin: Point;
      current: Rect;
      dragged: boolean;
    }
  | {
      kind: "resizing";
      shapeId: string;
      shape: ShapeKind;
      handle: HandleId;
      start: Rect;
      origin: Point;
      current: Rect;
    };

export type Effect =
  | { type: "select"; shapeId: string | null }
  | { type: "create"; shape: ShapeKind; rect: Rect }
  | { type: "update"; shapeId: string; changes: Partial<Rect> }
  | { type: "preview"; shapeId: string; changes: Partial<Rect> }
  /** Open the text box for a `text` shape that does not exist yet; it is created when the person finishes typing. */
  | { type: "begin_text"; rect: Rect }
  /** Open the text box over an existing shape. */
  | { type: "edit_text"; shapeId: string };

export type InteractionContext = {
  tool: Tool;
  /** Live shapes, back to front. */
  shapes: readonly ShapeGeometry[];
  selectedId: string | null;
};

export type Step = { state: Interaction; effects: Effect[] };

/** A press that moves less than this is a click, not a drag. */
export const DRAG_THRESHOLD = 3;
/** Size of a box made by clicking instead of dragging. */
export const DEFAULT_SIZE = { width: 120, height: 80 };
/** Length of a line or arrow made by clicking instead of dragging. */
export const DEFAULT_LINE_LENGTH = 120;

export const IDLE: Interaction = { kind: "idle" };

const stay = (state: Interaction): Step => ({ state, effects: [] });

export function pointerDown(state: Interaction, ctx: InteractionContext, point: Point): Step {
  if (state.kind !== "idle") return stay(state);

  if (ctx.tool !== "select") {
    return {
      state: { kind: "creating", shape: ctx.tool, origin: point, current: point, constrain: false },
      effects: [{ type: "select", shapeId: null }],
    };
  }

  // Select tool. A handle of the selected shape wins over whatever is underneath it.
  const selected = ctx.selectedId ? ctx.shapes.find((shape) => shape.id === ctx.selectedId) : undefined;
  if (selected) {
    const handle = hitHandleFor(selected.kind, selected.rect, point);
    if (handle) {
      return {
        state: {
          kind: "resizing",
          shapeId: selected.id,
          shape: selected.kind,
          handle,
          start: selected.rect,
          origin: point,
          current: selected.rect,
        },
        effects: [],
      };
    }
  }

  const hit = hitTest(ctx.shapes, point);
  if (!hit) return { state: IDLE, effects: [{ type: "select", shapeId: null }] };
  const target = ctx.shapes.find((shape) => shape.id === hit)!;
  return {
    state: {
      kind: "moving",
      shapeId: hit,
      shape: target.kind,
      start: target.rect,
      origin: point,
      current: target.rect,
      dragged: false,
    },
    effects: [{ type: "select", shapeId: hit }],
  };
}

export function pointerMove(state: Interaction, point: Point, constrain = false): Step {
  switch (state.kind) {
    case "idle":
      return stay(state);
    case "creating":
      return stay({ ...state, current: point, constrain });
    case "moving": {
      const dragged = state.dragged || distance(point, state.origin) >= DRAG_THRESHOLD;
      if (!dragged) return stay(state);
      const current = moveRect(state.start, ...moveBy(state, point, constrain));
      const rect = sanitizeShape(state.shape, current);
      return {
        state: { ...state, dragged: true, current },
        effects: [{ type: "preview", shapeId: state.shapeId, changes: { x: rect.x, y: rect.y } }],
      };
    }
    case "resizing": {
      const current = resized(state, point, constrain);
      const rect = sanitizeShape(state.shape, current);
      return {
        state: { ...state, current },
        effects: [{ type: "preview", shapeId: state.shapeId, changes: rect }],
      };
    }
  }
}

export function pointerUp(state: Interaction, point: Point, constrain = false): Step {
  switch (state.kind) {
    case "idle":
      return stay(state);
    case "creating":
      return { state: IDLE, effects: [finishCreating({ ...state, constrain }, point)] };
    case "moving": {
      // The release point is authoritative: it can differ from the last move event.
      if (!state.dragged && distance(point, state.origin) < DRAG_THRESHOLD)
        return { state: IDLE, effects: [] };
      const final = moveRect(state.start, ...moveBy(state, point, constrain));
      return { state: IDLE, effects: commit(state.shapeId, state.shape, state.start, final) };
    }
    case "resizing": {
      const final = resized(state, point, constrain);
      return { state: IDLE, effects: commit(state.shapeId, state.shape, state.start, final) };
    }
  }
}

/** How far a drag has moved the shape: the pointer's travel, locked to one axis with Shift. */
function moveBy(
  state: Extract<Interaction, { kind: "moving" }>,
  point: Point,
  constrain: boolean,
): [number, number] {
  const dx = point.x - state.origin.x;
  const dy = point.y - state.origin.y;
  if (!constrain) return [dx, dy];
  const locked = lockAxis(dx, dy);
  return [locked.dx, locked.dy];
}

function resized(state: Extract<Interaction, { kind: "resizing" }>, point: Point, constrain: boolean): Rect {
  let dx = point.x - state.origin.x;
  let dy = point.y - state.origin.y;
  // Shift on a line end: snap the line to 45 degree steps around the end that stays put.
  if (constrain && (state.handle === "start" || state.handle === "end")) {
    const { start, end } = lineEnds(state.start);
    const fixed = state.handle === "end" ? start : end;
    const grabbed = state.handle === "end" ? end : start;
    const snapped = snapAngle(fixed, { x: grabbed.x + dx, y: grabbed.y + dy });
    dx = snapped.x - grabbed.x;
    dy = snapped.y - grabbed.y;
  }
  return resizeShape(state.start, state.handle, dx, dy);
}

/** The point a drag of a new shape effectively ends at, after Shift constraints. */
function creationEnd(shape: ShapeKind, origin: Point, point: Point, constrain: boolean): Point {
  if (!constrain) return point;
  return isLinearKind(shape) ? snapAngle(origin, point) : squareFrom(origin, point);
}

function finishCreating(state: Extract<Interaction, { kind: "creating" }>, point: Point): Effect {
  const { shape, origin } = state;
  const end = creationEnd(shape, origin, point, state.constrain);
  const wasClick = distance(origin, point) < DRAG_THRESHOLD;

  if (isLinearKind(shape)) {
    const tooShort = distance(origin, end) < MIN_LINE_LENGTH;
    const rect: Rect =
      wasClick || tooShort
        ? { x: point.x - DEFAULT_LINE_LENGTH / 2, y: point.y, width: DEFAULT_LINE_LENGTH, height: 0 }
        : { x: origin.x, y: origin.y, width: end.x - origin.x, height: end.y - origin.y };
    return { type: "create", shape, rect: sanitizeShape(shape, rect) };
  }

  if (shape === "text") {
    const dragged = normalizeRect(origin, end);
    const rect: Rect =
      wasClick || dragged.width < MIN_SIZE
        ? { x: point.x, y: point.y, width: DEFAULT_TEXT_WIDTH, height: minTextHeight() }
        : { x: dragged.x, y: dragged.y, width: clampTextWidth(dragged.width), height: minTextHeight() };
    return { type: "begin_text", rect: sanitizeShape(shape, rect) };
  }

  const dragged = normalizeRect(origin, end);
  const tooSmall = dragged.width < MIN_SIZE || dragged.height < MIN_SIZE;
  const rect: Rect =
    wasClick || tooSmall
      ? { x: point.x - DEFAULT_SIZE.width / 2, y: point.y - DEFAULT_SIZE.height / 2, ...DEFAULT_SIZE }
      : dragged;
  return { type: "create", shape, rect: sanitizeShape(shape, rect) };
}

/** The single update op for a finished move or resize, or nothing if the shape ended up where it began. */
function commit(shapeId: string, shape: ShapeKind, start: Rect, final: Rect): Effect[] {
  const changes = changedFields(sanitizeShape(shape, start), sanitizeShape(shape, final));
  return Object.keys(changes).length > 0 ? [{ type: "update", shapeId, changes }] : [];
}

/** Escape: abandon the gesture. Nothing was committed, so there is nothing to undo. */
export function cancel(): Step {
  return { state: IDLE, effects: [] };
}

/**
 * A double click: edit the label of the shape under the pointer, or, on empty
 * canvas, start a new piece of text there. Lines and arrows have no text.
 */
export function doubleClick(ctx: InteractionContext, point: Point): Effect | null {
  const hit = hitTest(ctx.shapes, point);
  if (hit === null) {
    return {
      type: "begin_text",
      rect: sanitizeShape("text", {
        x: point.x,
        y: point.y,
        width: DEFAULT_TEXT_WIDTH,
        height: minTextHeight(),
      }),
    };
  }
  const target = ctx.shapes.find((shape) => shape.id === hit)!;
  return isLinearKind(target.kind) ? null : { type: "edit_text", shapeId: hit };
}

/** The rectangle a shape should be DRAWN at while this gesture is in progress, if it affects one. */
export function dragOverride(state: Interaction): { shapeId: string; rect: Rect } | null {
  if (state.kind === "moving" && state.dragged)
    return { shapeId: state.shapeId, rect: sanitizeShape(state.shape, state.current) };
  if (state.kind === "resizing")
    return { shapeId: state.shapeId, rect: sanitizeShape(state.shape, state.current) };
  return null;
}

/** The outline of the shape being drawn, if one is. */
export function creationGhost(state: Interaction): { kind: ShapeKind; rect: Rect } | null {
  if (state.kind !== "creating") return null;
  const { shape, origin } = state;
  const end = creationEnd(shape, origin, state.current, state.constrain);
  return {
    kind: shape,
    rect: isLinearKind(shape)
      ? { x: origin.x, y: origin.y, width: end.x - origin.x, height: end.y - origin.y }
      : normalizeRect(origin, end),
  };
}

/** The mouse cursor that tells the person what a press here would do. */
export function cursorFor(state: Interaction, ctx: InteractionContext, point: Point | null): string {
  switch (state.kind) {
    case "creating":
      return "crosshair";
    case "moving":
      return state.dragged ? "grabbing" : "move";
    case "resizing":
      return handleCursor(state.handle);
    case "idle":
      break;
  }
  if (ctx.tool !== "select") return ctx.tool === "text" ? "text" : "crosshair";
  if (!point) return "default";
  const selected = ctx.selectedId ? ctx.shapes.find((shape) => shape.id === ctx.selectedId) : undefined;
  const handle = selected ? hitHandleFor(selected.kind, selected.rect, point) : null;
  if (handle) return handleCursor(handle);
  return hitTest(ctx.shapes, point) ? "move" : "default";
}

function handleCursor(handle: HandleId): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "crosshair";
  }
}
