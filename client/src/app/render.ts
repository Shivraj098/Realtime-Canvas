import { shade } from "./color";
import { HANDLE_SIZE, handlePositions, HANDLES, type Rect } from "./geometry";
import type { DrawnCursor, DrawnShape, Scene } from "./scene";

/** Colours and type for the canvas, read from the page's CSS so light and dark mode both work. */
export type Theme = {
  background: string;
  grid: string;
  selection: string;
  handleFill: string;
  labelText: string;
  shadow: string;
  font: string;
};

export type Viewport = { width: number; height: number; dpr: number };

const GRID_SPACING = 24;
const CORNER_RADIUS = 6;

function roundedRectPath(ctx: CanvasRenderingContext2D, rect: Rect, radius: number): void {
  const r = Math.min(radius, rect.width / 2, rect.height / 2);
  const { x, y, width, height } = rect;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawGrid(ctx: CanvasRenderingContext2D, theme: Theme, view: Viewport): void {
  ctx.fillStyle = theme.grid;
  for (let x = GRID_SPACING; x < view.width; x += GRID_SPACING) {
    for (let y = GRID_SPACING; y < view.height; y += GRID_SPACING) {
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
  }
}

function drawShape(ctx: CanvasRenderingContext2D, shape: DrawnShape, theme: Theme): void {
  ctx.save();
  if (shape.mode === "dragging") {
    ctx.shadowColor = theme.shadow;
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
  }
  if (shape.mode === "remote-preview") ctx.globalAlpha = 0.85;

  roundedRectPath(ctx, shape.rect, CORNER_RADIUS);
  ctx.fillStyle = shape.color;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.5;
  if (shape.mode === "remote-preview") {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = shape.ownerColor ?? theme.selection;
    ctx.lineWidth = 2;
  } else {
    ctx.strokeStyle = shade(shape.color, -0.28);
  }
  ctx.stroke();
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, rect: Rect, theme: Theme): void {
  ctx.save();
  roundedRectPath(ctx, rect, CORNER_RADIUS);
  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 2;
  ctx.stroke();

  const half = (HANDLE_SIZE - 2) / 2;
  const positions = handlePositions(rect);
  for (const id of HANDLES) {
    const corner = positions[id];
    ctx.beginPath();
    ctx.rect(corner.x - half, corner.y - half, half * 2, half * 2);
    ctx.fillStyle = theme.handleFill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function drawGhost(ctx: CanvasRenderingContext2D, ghost: { rect: Rect; color: string }, theme: Theme): void {
  ctx.save();
  roundedRectPath(ctx, ghost.rect, CORNER_RADIUS);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = ghost.color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function drawCursor(ctx: CanvasRenderingContext2D, cursor: DrawnCursor, theme: Theme): void {
  ctx.save();
  ctx.translate(cursor.x, cursor.y);

  // The pointer arrow, tip at the reported position.
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 16);
  ctx.lineTo(4.5, 12);
  ctx.lineTo(8, 19);
  ctx.lineTo(10.5, 18);
  ctx.lineTo(7, 11);
  ctx.lineTo(12.5, 11);
  ctx.closePath();
  ctx.fillStyle = cursor.color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.handleFill;
  ctx.stroke();

  // Name tag.
  ctx.font = theme.font;
  const padding = 6;
  const textWidth = ctx.measureText(cursor.label).width;
  const tag: Rect = { x: 12, y: 18, width: textWidth + padding * 2, height: 18 };
  roundedRectPath(ctx, tag, 9);
  ctx.fillStyle = cursor.color;
  ctx.fill();
  ctx.fillStyle = theme.labelText;
  ctx.textBaseline = "middle";
  ctx.fillText(cursor.label, tag.x + padding, tag.y + tag.height / 2 + 0.5);
  ctx.restore();
}

/** Draws one frame. The canvas backing store is `dpr` times larger than its CSS size; this works in CSS pixels. */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, theme: Theme, view: Viewport): void {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, view.width, view.height);
  drawGrid(ctx, theme, view);

  for (const shape of scene.shapes) drawShape(ctx, shape, theme);
  if (scene.selectedRect) drawSelection(ctx, scene.selectedRect, theme);
  if (scene.ghost) drawGhost(ctx, scene.ghost, theme);
  // Cursors last: they float above everything.
  for (const cursor of scene.cursors) drawCursor(ctx, cursor, theme);
}
