import type { RoomState } from "@realtime-canvas/shared";
import { drawScene, type Theme } from "./render";
import { buildExportScene } from "./scene";

/** Pixels per CSS pixel in the saved picture: twice, so text and edges stay sharp when zoomed in. */
const EXPORT_SCALE = 2;

/**
 * Draws the board's shapes (nothing else: no cursors, handles or previews)
 * onto a fresh canvas and hands it back as a PNG. Null for an empty board.
 */
export function renderBoardImage(liveShapes: RoomState, theme: Theme): Promise<Blob | null> {
  const built = buildExportScene(liveShapes);
  if (!built) return Promise.resolve(null);
  const canvas = document.createElement("canvas");
  canvas.width = built.width * EXPORT_SCALE;
  canvas.height = built.height * EXPORT_SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  drawScene(ctx, built.scene, theme, { width: built.width, height: built.height, dpr: EXPORT_SCALE });
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** Saves a blob as a file by clicking a temporary link, the way a browser offers a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
