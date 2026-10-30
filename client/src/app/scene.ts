import type { RoomState, ShapeKind } from "@realtime-canvas/shared";
import type { PresenceEntry, RemotePreview } from "../sync/sync-engine";
import { boundsOf, type Rect, type ShapeGeometry } from "./geometry";
import { creationGhost, dragOverride, type Interaction } from "./interaction";
import type { SmoothedCursor } from "./smoothing";

/**
 * Turns the engine's state and the local gesture into a description of what
 * to draw. Drawing is a separate step (render.ts), so the decisions - which
 * shape is shown where, who is previewing what - are plain data in, plain
 * data out, and testable without a canvas.
 */

export type ShapeMode =
  /** Where the room agrees it is. */
  | "normal"
  /** Being dragged or resized by this user right now. */
  | "dragging"
  /** Being dragged by someone else right now; shown at their preview position. */
  | "remote-preview";

export type DrawnShape = {
  id: string;
  kind: ShapeKind;
  /** For a line or arrow this is a vector (see geometry.ts); for everything else, the box. */
  rect: Rect;
  color: string;
  text: string;
  mode: ShapeMode;
  /** Colour of the person previewing it, for `remote-preview`. */
  ownerColor?: string;
  /** 0 to 1 while the shape is popping in; absent once it has settled. */
  appear?: number;
  /** The text box is open over this shape, so its own text is not drawn. */
  editing?: boolean;
};

export type DrawnCursor = { clientId: string; x: number; y: number; color: string; label: string };

export type Scene = {
  shapes: DrawnShape[];
  selection: { kind: ShapeKind; rect: Rect } | null;
  ghost: { kind: ShapeKind; rect: Rect; color: string } | null;
  /** The outline of a text box that is open but whose shape does not exist yet. */
  draft: Rect | null;
  cursors: DrawnCursor[];
};

export type SceneInput = {
  liveShapes: RoomState;
  previews: readonly RemotePreview[];
  presence: readonly PresenceEntry[];
  interaction: Interaction;
  selectedId: string | null;
  newShapeColor: string;
  cursors: readonly SmoothedCursor[];
  /** Progress (0 to 1) of shapes that are popping in. */
  appearing?: ReadonlyMap<string, number>;
  /** The shape whose text box is open, if any. */
  editingId?: string | null;
  /** Where a new text shape is being typed, if a text box is open for one. */
  draft?: Rect | null;
};

const UNKNOWN_OWNER_COLOR = "#8a8a8a";

/** A short, stable name for someone with no display name: the start of their id. */
export function labelFor(clientId: string): string {
  return clientId.slice(0, 4);
}

/** Live shapes, back to front (the order they are drawn and hit-tested in). */
export function orderedShapes(liveShapes: RoomState): (ShapeGeometry & { color: string; text: string })[] {
  return Object.entries(liveShapes).map(([id, shape]) => ({
    id,
    kind: shape.kind,
    rect: { x: shape.x, y: shape.y, width: shape.width, height: shape.height },
    color: shape.color,
    text: shape.text,
  }));
}

function latestPreviewFor(previews: readonly RemotePreview[], shapeId: string): RemotePreview | undefined {
  for (let i = previews.length - 1; i >= 0; i--) {
    if (previews[i]!.shapeId === shapeId) return previews[i];
  }
  return undefined;
}

export function buildScene(input: SceneInput): Scene {
  const override = dragOverride(input.interaction);
  const colorOf = (clientId: string): string =>
    input.presence.find((entry) => entry.clientId === clientId)?.color ?? UNKNOWN_OWNER_COLOR;

  const shapes: DrawnShape[] = orderedShapes(input.liveShapes).map((shape): DrawnShape => {
    const base: DrawnShape = { ...shape, mode: "normal" };
    const appear = input.appearing?.get(shape.id);
    if (appear !== undefined) base.appear = appear;
    if (input.editingId === shape.id) base.editing = true;

    if (override && override.shapeId === shape.id) {
      return { ...base, rect: override.rect, mode: "dragging" };
    }
    // If two people drag the same shape, the most recent preview wins.
    const preview = latestPreviewFor(input.previews, shape.id);
    if (preview) {
      return {
        ...base,
        rect: { ...shape.rect, ...preview.changes },
        mode: "remote-preview",
        ownerColor: colorOf(preview.clientId),
      };
    }
    return base;
  });

  const selected = input.selectedId ? shapes.find((shape) => shape.id === input.selectedId) : undefined;
  const ghost = creationGhost(input.interaction);

  return {
    shapes,
    selection: selected ? { kind: selected.kind, rect: selected.rect } : null,
    ghost: ghost ? { ...ghost, color: input.newShapeColor } : null,
    draft: input.draft ?? null,
    cursors: input.cursors.map((cursor) => ({
      clientId: cursor.clientId,
      x: cursor.x,
      y: cursor.y,
      color: cursor.color,
      label: labelFor(cursor.clientId),
    })),
  };
}

const EXPORT_PADDING = 32;

/**
 * The shapes of a board as an image: the scene with nothing but the shapes
 * (no selection, cursors or previews), moved so the drawing starts
 * `EXPORT_PADDING` from the top-left corner, and the size of that image.
 * Null for an empty board, which has nothing to export.
 */
export function buildExportScene(
  liveShapes: RoomState,
): { scene: Scene; width: number; height: number } | null {
  const shapes = orderedShapes(liveShapes);
  if (shapes.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const shape of shapes) {
    const box = boundsOf(shape.kind, shape.rect);
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  const dx = EXPORT_PADDING - left;
  const dy = EXPORT_PADDING - top;
  return {
    scene: {
      shapes: shapes.map((shape) => ({
        ...shape,
        rect: { ...shape.rect, x: shape.rect.x + dx, y: shape.rect.y + dy },
        mode: "normal",
      })),
      selection: null,
      ghost: null,
      draft: null,
      cursors: [],
    },
    width: Math.ceil(right - left + EXPORT_PADDING * 2),
    height: Math.ceil(bottom - top + EXPORT_PADDING * 2),
  };
}
