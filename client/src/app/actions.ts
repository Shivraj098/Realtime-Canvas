import { getShape, isDeleted } from "@realtime-canvas/shared";
import type { RoomClient } from "../room-client";
import type { AppState } from "./state";
import { duplicateOf } from "./shortcuts";

/**
 * Things the person can do to the selected shape that are not part of a
 * pointer gesture: delete it, copy it. Shared by the keyboard shortcuts and
 * the toolbar buttons, so the two can never disagree about what they do.
 */

export function deleteSelected(client: RoomClient, state: AppState): void {
  const selected = state.getSelectedId();
  if (!selected) return;
  client.deleteShape(selected);
  state.setSelectedId(null);
}

/** Copies the selected shape a little down and to the right, and selects the copy. Returns whether a copy was made. */
export function duplicateSelected(client: RoomClient, state: AppState): boolean {
  const selected = state.getSelectedId();
  if (!selected) return false;
  const shape = getShape(client.engine.getView(), selected);
  if (!shape || isDeleted(shape)) return false;
  const copy = duplicateOf(shape);
  const result = client.createShape(copy.kind, copy.fields);
  if (!result.ok) return false;
  state.setSelectedId(result.op.shapeId);
  return true;
}
