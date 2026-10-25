import {
  changedFields,
  distance,
  hitHandle,
  hitTest,
  moveRect,
  normalizeRect,
  resizeRect,
  sanitizeRect,
  MIN_SIZE,
  type HandleId,
  type Point,
  type Rect,
} from "./geometry";

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
 */

export type Tool = "select" | "rectangle";

export type Interaction =
  | { kind: "idle" }
  | { kind: "creating"; origin: Point; current: Point }
  | { kind: "moving"; shapeId: string; start: Rect; origin: Point; current: Rect; dragged: boolean }
  | { kind: "resizing"; shapeId: string; handle: HandleId; start: Rect; origin: Point; current: Rect };

export type Effect =
  | { type: "select"; shapeId: string | null }
  | { type: "create"; rect: Rect }
  | { type: "update"; shapeId: string; changes: Partial<Rect> }
  | { type: "preview"; shapeId: string; changes: Partial<Rect> };

export type InteractionContext = {
  tool: Tool;
  /** Live shapes, back to front. */
  shapes: readonly { id: string; rect: Rect }[];
  selectedId: string | null;
};

export type Step = { state: Interaction; effects: Effect[] };

/** A press that moves less than this is a click, not a drag. */
export const DRAG_THRESHOLD = 3;
/** Size of a rectangle made by clicking instead of dragging. */
export const DEFAULT_SIZE = { width: 120, height: 80 };

export const IDLE: Interaction = { kind: "idle" };

const stay = (state: Interaction): Step => ({ state, effects: [] });

export function pointerDown(state: Interaction, ctx: InteractionContext, point: Point): Step {
  if (state.kind !== "idle") return stay(state);

  if (ctx.tool === "rectangle") {
    return {
      state: { kind: "creating", origin: point, current: point },
      effects: [{ type: "select", shapeId: null }],
    };
  }

  // Select tool. A handle of the selected shape wins over whatever is underneath it.
  const selected = ctx.selectedId ? ctx.shapes.find((shape) => shape.id === ctx.selectedId) : undefined;
  if (selected) {
    const handle = hitHandle(selected.rect, point);
    if (handle) {
      return {
        state: {
          kind: "resizing",
          shapeId: selected.id,
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
  const rect = ctx.shapes.find((shape) => shape.id === hit)!.rect;
  return {
    state: { kind: "moving", shapeId: hit, start: rect, origin: point, current: rect, dragged: false },
    effects: [{ type: "select", shapeId: hit }],
  };
}

export function pointerMove(state: Interaction, point: Point): Step {
  switch (state.kind) {
    case "idle":
      return stay(state);
    case "creating":
      return stay({ ...state, current: point });
    case "moving": {
      const dragged = state.dragged || distance(point, state.origin) >= DRAG_THRESHOLD;
      if (!dragged) return stay(state);
      const current = moveRect(state.start, point.x - state.origin.x, point.y - state.origin.y);
      const rect = sanitizeRect(current);
      return {
        state: { ...state, dragged: true, current },
        effects: [{ type: "preview", shapeId: state.shapeId, changes: { x: rect.x, y: rect.y } }],
      };
    }
    case "resizing": {
      const current = resizeRect(
        state.start,
        state.handle,
        point.x - state.origin.x,
        point.y - state.origin.y,
      );
      const rect = sanitizeRect(current);
      return {
        state: { ...state, current },
        effects: [{ type: "preview", shapeId: state.shapeId, changes: rect }],
      };
    }
  }
}

export function pointerUp(state: Interaction, point: Point): Step {
  switch (state.kind) {
    case "idle":
      return stay(state);
    case "creating": {
      const wasClick = distance(state.origin, point) < DRAG_THRESHOLD;
      const dragged = normalizeRect(state.origin, point);
      const tooSmall = dragged.width < MIN_SIZE || dragged.height < MIN_SIZE;
      const rect =
        wasClick || tooSmall
          ? {
              x: point.x - DEFAULT_SIZE.width / 2,
              y: point.y - DEFAULT_SIZE.height / 2,
              ...DEFAULT_SIZE,
            }
          : dragged;
      return { state: IDLE, effects: [{ type: "create", rect: sanitizeRect(rect) }] };
    }
    case "moving": {
      // The release point is authoritative: it can differ from the last move event.
      if (!state.dragged && distance(point, state.origin) < DRAG_THRESHOLD)
        return { state: IDLE, effects: [] };
      const final = moveRect(state.start, point.x - state.origin.x, point.y - state.origin.y);
      return { state: IDLE, effects: commitMove(state.shapeId, state.start, final) };
    }
    case "resizing": {
      const final = resizeRect(state.start, state.handle, point.x - state.origin.x, point.y - state.origin.y);
      return { state: IDLE, effects: commitMove(state.shapeId, state.start, final) };
    }
  }
}

/** The single update op for a finished move or resize, or nothing if the shape ended up where it began. */
function commitMove(shapeId: string, start: Rect, final: Rect): Effect[] {
  const changes = changedFields(sanitizeRect(start), sanitizeRect(final));
  return Object.keys(changes).length > 0 ? [{ type: "update", shapeId, changes }] : [];
}

/** Escape: abandon the gesture. Nothing was committed, so there is nothing to undo. */
export function cancel(): Step {
  return { state: IDLE, effects: [] };
}

/** The rectangle a shape should be DRAWN at while this gesture is in progress, if it affects one. */
export function dragOverride(state: Interaction): { shapeId: string; rect: Rect } | null {
  if (state.kind === "moving" && state.dragged)
    return { shapeId: state.shapeId, rect: sanitizeRect(state.current) };
  if (state.kind === "resizing") return { shapeId: state.shapeId, rect: sanitizeRect(state.current) };
  return null;
}

/** The outline of the rectangle being drawn, if one is. */
export function creationGhost(state: Interaction): Rect | null {
  return state.kind === "creating" ? normalizeRect(state.origin, state.current) : null;
}
