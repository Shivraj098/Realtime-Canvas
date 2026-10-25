import type { RoomState } from "@realtime-canvas/shared";
import type { PresenceEntry, RemotePreview } from "../sync/sync-engine";
import type { Rect } from "./geometry";
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
  rect: Rect;
  color: string;
  mode: ShapeMode;
  /** Colour of the person previewing it, for `remote-preview`. */
  ownerColor?: string;
};

export type DrawnCursor = { clientId: string; x: number; y: number; color: string; label: string };

export type Scene = {
  shapes: DrawnShape[];
  selectedRect: Rect | null;
  ghost: { rect: Rect; color: string } | null;
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
};

const UNKNOWN_OWNER_COLOR = "#8a8a8a";

/** A short, stable name for someone with no display name: the start of their id. */
export function labelFor(clientId: string): string {
  return clientId.slice(0, 4);
}

/** Live shapes as rectangles, back to front (the order they are drawn and hit-tested in). */
export function orderedShapes(liveShapes: RoomState): { id: string; rect: Rect; color: string }[] {
  return Object.entries(liveShapes).map(([id, shape]) => ({
    id,
    rect: { x: shape.x, y: shape.y, width: shape.width, height: shape.height },
    color: shape.color,
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

  const shapes: DrawnShape[] = orderedShapes(input.liveShapes).map((shape) => {
    if (override && override.shapeId === shape.id) {
      return { ...shape, rect: override.rect, mode: "dragging" };
    }
    // If two people drag the same shape, the most recent preview wins.
    const preview = latestPreviewFor(input.previews, shape.id);
    if (preview) {
      return {
        ...shape,
        rect: { ...shape.rect, ...preview.changes },
        mode: "remote-preview",
        ownerColor: colorOf(preview.clientId),
      };
    }
    return { ...shape, mode: "normal" };
  });

  const selected = input.selectedId ? shapes.find((shape) => shape.id === input.selectedId) : undefined;
  const ghostRect = creationGhost(input.interaction);

  return {
    shapes,
    selectedRect: selected ? selected.rect : null,
    ghost: ghostRect ? { rect: ghostRect, color: input.newShapeColor } : null,
    cursors: input.cursors.map((cursor) => ({
      clientId: cursor.clientId,
      x: cursor.x,
      y: cursor.y,
      color: cursor.color,
      label: labelFor(cursor.clientId),
    })),
  };
}
