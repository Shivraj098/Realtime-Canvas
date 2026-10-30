import { isLinearKind, type ShapeKind } from "@realtime-canvas/shared";
import { shade } from "./color";
import {
  boundsOf,
  diamondPoints,
  HANDLE_SIZE,
  handlesFor,
  lineEnds,
  trianglePoints,
  type Point,
  type Rect,
} from "./geometry";
import type { DrawnCursor, DrawnShape, Scene } from "./scene";
import {
  fontFor,
  isCentered,
  labelArea,
  lineHeightFor,
  visibleLines,
  wrapText,
  type Measure,
} from "./text-layout";

/** Colours and type for the canvas, read from the page's CSS so light and dark mode both work. */
export type Theme = {
  background: string;
  grid: string;
  selection: string;
  handleFill: string;
  labelText: string;
  shadow: string;
  font: string;
  /** Ink for the label of a closed shape. The fills are pastel in both modes, so this stays dark. */
  shapeInk: string;
  /** How much to darken (negative) or lighten a `text` shape's colour so it reads on the background. */
  textShade: number;
};

export type Viewport = { width: number; height: number; dpr: number };

const GRID_SPACING = 24;
const CORNER_RADIUS = 6;
const LINE_WIDTH = 3.5;
const ARROW_HEAD = 16;

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

function polygonPath(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  ctx.beginPath();
  points.forEach((point, index) =>
    index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y),
  );
  ctx.closePath();
}

/** Traces the outline of a closed shape (everything but a line, arrow or text). */
function outlinePath(ctx: CanvasRenderingContext2D, kind: ShapeKind, rect: Rect): void {
  switch (kind) {
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      return;
    case "diamond":
      polygonPath(ctx, diamondPoints(rect));
      return;
    case "triangle":
      polygonPath(ctx, trianglePoints(rect));
      return;
    default:
      roundedRectPath(ctx, rect, CORNER_RADIUS);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, theme: Theme, view: Viewport): void {
  ctx.fillStyle = theme.grid;
  for (let x = GRID_SPACING; x < view.width; x += GRID_SPACING) {
    for (let y = GRID_SPACING; y < view.height; y += GRID_SPACING) {
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
  }
}

/** The easing of the pop-in: quick at first, settling gently. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function measureWith(ctx: CanvasRenderingContext2D): Measure {
  return (text) => ctx.measureText(text).width;
}

function drawText(
  ctx: CanvasRenderingContext2D,
  kind: ShapeKind,
  rect: Rect,
  text: string,
  ink: string,
): void {
  const area = labelArea(kind, rect);
  if (!area || text === "" || area.width <= 0) return;
  ctx.save();
  ctx.font = fontFor(kind);
  ctx.fillStyle = ink;
  ctx.textBaseline = "top";
  const lineHeight = lineHeightFor(kind);
  const lines = wrapText(text, area.width, measureWith(ctx));
  const shown = kind === "text" ? lines : visibleLines(lines, area.height, lineHeight);
  const centered = isCentered(kind);
  ctx.textAlign = centered ? "center" : "left";
  // A label is centred vertically in its area; a text shape starts at the top.
  const top = centered ? area.y + Math.max(0, (area.height - shown.length * lineHeight) / 2) : area.y;
  const left = centered ? area.x + area.width / 2 : area.x;
  shown.forEach((line, index) => ctx.fillText(line, left, top + index * lineHeight));
  ctx.restore();
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0) return;
  const size = Math.min(ARROW_HEAD, length * 0.6);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - spread), to.y - size * Math.sin(angle - spread));
  ctx.lineTo(to.x - size * Math.cos(angle + spread), to.y - size * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fill();
}

function drawLinear(ctx: CanvasRenderingContext2D, shape: DrawnShape): void {
  const { start, end } = lineEnds(shape.rect);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = LINE_WIDTH;
  ctx.strokeStyle = shape.mode === "remote-preview" ? (shape.ownerColor ?? shape.color) : shape.color;
  ctx.fillStyle = ctx.strokeStyle;
  if (shape.mode === "remote-preview") ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.setLineDash([]);
  if (shape.kind === "arrow") drawArrowHead(ctx, start, end);
}

function drawShape(ctx: CanvasRenderingContext2D, shape: DrawnShape, theme: Theme): void {
  ctx.save();

  // Popping in: grow from the centre of the shape's box while fading in.
  if (shape.appear !== undefined) {
    const eased = easeOut(shape.appear);
    const box = boundsOf(shape.kind, shape.rect);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const scale = 0.8 + 0.2 * eased;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.globalAlpha = eased;
  }
  if (shape.mode === "remote-preview") ctx.globalAlpha *= 0.85;

  if (isLinearKind(shape.kind)) {
    drawLinear(ctx, shape);
    ctx.restore();
    return;
  }

  if (shape.kind === "text") {
    if (!shape.editing) {
      const ink = shade(shape.color, theme.textShade);
      drawText(ctx, "text", shape.rect, shape.text, ink);
    }
    if (shape.mode === "remote-preview") {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = shape.ownerColor ?? theme.selection;
      ctx.lineWidth = 2;
      roundedRectPath(ctx, shape.rect, CORNER_RADIUS);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // A closed shape: a soft shadow while it is being dragged, a gentle lift always.
  outlinePath(ctx, shape.kind, shape.rect);
  if (shape.mode === "dragging") {
    ctx.shadowColor = theme.shadow;
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
  } else {
    ctx.shadowColor = theme.shadow;
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
  }
  const gradient = ctx.createLinearGradient(0, shape.rect.y, 0, shape.rect.y + shape.rect.height);
  gradient.addColorStop(0, shade(shape.color, 0.14));
  gradient.addColorStop(1, shape.color);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineJoin = "round";
  ctx.lineWidth = 1.5;
  if (shape.mode === "remote-preview") {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = shape.ownerColor ?? theme.selection;
    ctx.lineWidth = 2;
  } else {
    ctx.strokeStyle = shade(shape.color, -0.28);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (!shape.editing) drawText(ctx, shape.kind, shape.rect, shape.text, theme.shapeInk);
  ctx.restore();
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  selection: { kind: ShapeKind; rect: Rect },
  theme: Theme,
): void {
  const { kind, rect } = selection;
  ctx.save();
  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 2;
  if (isLinearKind(kind)) {
    // A line is selected by its two ends; there is no box to outline.
    const { start, end } = lineEnds(rect);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = LINE_WIDTH + 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;
    for (const { point } of handlesFor(kind, rect)) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, HANDLE_SIZE / 2 - 0.5, 0, Math.PI * 2);
      ctx.fillStyle = theme.handleFill;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  roundedRectPath(ctx, rect, CORNER_RADIUS);
  ctx.stroke();
  const half = (HANDLE_SIZE - 2) / 2;
  for (const { point } of handlesFor(kind, rect)) {
    ctx.beginPath();
    ctx.rect(point.x - half, point.y - half, half * 2, half * 2);
    ctx.fillStyle = theme.handleFill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function drawGhost(
  ctx: CanvasRenderingContext2D,
  ghost: { kind: ShapeKind; rect: Rect; color: string },
  theme: Theme,
): void {
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 1.5;
  if (isLinearKind(ghost.kind)) {
    const { start, end } = lineEnds(ghost.rect);
    ctx.strokeStyle = ghost.color;
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = "round";
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    if (ghost.kind === "arrow") {
      ctx.setLineDash([]);
      ctx.fillStyle = ghost.color;
      drawArrowHead(ctx, start, end);
    }
  } else if (ghost.kind === "text") {
    roundedRectPath(ctx, ghost.rect, CORNER_RADIUS);
    ctx.stroke();
  } else {
    outlinePath(ctx, ghost.kind, ghost.rect);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = ghost.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
  }
  ctx.restore();
}

function drawDraft(ctx: CanvasRenderingContext2D, rect: Rect, theme: Theme): void {
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, rect, CORNER_RADIUS);
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
  if (scene.selection) drawSelection(ctx, scene.selection, theme);
  if (scene.ghost) drawGhost(ctx, scene.ghost, theme);
  if (scene.draft) drawDraft(ctx, scene.draft, theme);
  // Cursors last: they float above everything.
  for (const cursor of scene.cursors) drawCursor(ctx, cursor, theme);
}
