import {
  getShape,
  isLinearKind,
  type GeometryChanges,
  type ShapeChanges,
  type ShapeKind,
} from "@realtime-canvas/shared";
import type { RoomClient } from "../room-client";
import { realScheduler } from "../net/types";
import { AppearTracker } from "./appear";
import { shade } from "./color";
import type { Point, Rect } from "./geometry";
import {
  cancel,
  cursorFor,
  doubleClick,
  IDLE,
  pointerDown,
  pointerMove,
  pointerUp,
  type Effect,
  type Interaction,
  type InteractionContext,
  type Step,
} from "./interaction";
import { renderBoardImage, downloadBlob } from "./export-image";
import { drawScene, type Theme } from "./render";
import { buildScene, orderedShapes } from "./scene";
import { CursorSmoother } from "./smoothing";
import type { AppState } from "./state";
import { TextEditor } from "./text-editor";
import { fontFor, textShapeHeight } from "./text-layout";
import { readTheme } from "./theme";
import { createThrottle } from "./throttle";

/** How often a cursor position or drag preview may be sent: about 30 times a second. */
const SEND_INTERVAL_MS = 33;

/**
 * The canvas and everything that touches it: sizing for the screen's pixel
 * density, pointer input, and the draw loop. The decisions live in the pure
 * modules (interaction, scene, render); this class only connects them to the
 * browser and the room client.
 *
 * It draws on demand rather than every frame: a frame is requested when the
 * room, the gesture, the selection or the size changes, and it keeps asking
 * for more only while something is still animating (a cursor catching up, a
 * drag preview waiting to expire).
 */
export class CanvasView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly smoother = new CursorSmoother();
  private readonly appearing = new AppearTracker();
  private readonly editor: TextEditor;
  private readonly measureContext = document.createElement("canvas").getContext("2d");
  private readonly cleanups: (() => void)[] = [];
  private readonly sendCursor;
  private readonly sendPreview;

  private interaction: Interaction = IDLE;
  private theme: Theme = readTheme();
  private size = { width: 0, height: 0, dpr: 1 };
  private frameRequest: number | null = null;
  private lastFrameTime: number | null = null;
  private lastPoint: Point | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly client: RoomClient,
    private readonly state: AppState,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw on a canvas");
    this.ctx = ctx;
    this.editor = new TextEditor(document.body);
    this.cleanups.push(() => this.editor.discard());

    const clock = { now: () => performance.now(), scheduler: realScheduler };
    this.sendCursor = createThrottle(
      (x: number, y: number) => this.client.sendCursor(x, y),
      SEND_INTERVAL_MS,
      clock,
    );
    this.sendPreview = createThrottle(
      (shapeId: string, changes: GeometryChanges) => this.client.sendDragPreview(shapeId, changes),
      SEND_INTERVAL_MS,
      clock,
    );

    this.attachPointerInput();
    this.attachSizing();
    this.attachTheme();
    this.cleanups.push(this.client.subscribe(() => this.requestDraw()));
    this.cleanups.push(this.state.subscribe(() => this.requestDraw()));
    this.requestDraw();
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.sendCursor.cancel();
    this.sendPreview.cancel();
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
  }

  /** Abandons the gesture in progress, if any (the Escape key). */
  cancelGesture(): void {
    this.sendPreview.cancel();
    this.apply(cancel());
  }

  requestDraw(): void {
    if (this.frameRequest !== null) return;
    this.frameRequest = requestAnimationFrame((time) => this.frame(time));
  }

  // ---- drawing -----------------------------------------------------------

  private frame(time: number): void {
    this.frameRequest = null;
    const dt = this.lastFrameTime === null ? 16 : Math.min(100, time - this.lastFrameTime);
    this.lastFrameTime = time;

    const engine = this.client.engine;
    engine.expirePreviews();
    const live = engine.getLiveShapes();

    // A shape deleted by someone else cannot stay selected.
    const selectedId = this.state.getSelectedId();
    if (selectedId !== null && !Object.hasOwn(live, selectedId)) this.state.setSelectedId(null);

    const targets = engine.getCursors();
    const cursors = this.smoother.step(targets, dt);
    // The board has its initial state once the server has told us who is here (it sends the state first).
    const appearing = this.appearing.update(Object.keys(live), time, engine.getPresence().length > 0);
    const editing = this.state.getEditing();
    const scene = buildScene({
      liveShapes: live,
      previews: engine.getPreviews(),
      presence: engine.getPresence(),
      interaction: this.interaction,
      selectedId: this.state.getSelectedId(),
      newShapeColor: this.state.getColor(),
      cursors,
      appearing,
      editingId: editing?.kind === "shape" ? editing.shapeId : null,
      draft: editing?.kind === "draft" ? editing.rect : null,
    });
    drawScene(this.ctx, scene, this.theme, this.size);

    // Exposed so tests can see that remote cursors are being drawn.
    this.canvas.dataset.remoteCursors = String(cursors.length);

    const animating =
      this.smoother.isAnimating(targets) || engine.getPreviews().length > 0 || this.appearing.isAnimating();
    if (animating) this.requestDraw();
    else this.lastFrameTime = null;
  }

  // ---- sizing and theme --------------------------------------------------

  private attachSizing(): void {
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(this.canvas.clientWidth));
      const height = Math.max(1, Math.floor(this.canvas.clientHeight));
      this.size = { width, height, dpr };
      // The backing store is dpr times the CSS size, so lines stay sharp on dense screens.
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.requestDraw();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(this.canvas);
    this.cleanups.push(() => observer.disconnect());

    // Moving the window to a screen with a different pixel density changes
    // devicePixelRatio without resizing anything.
    let stopWatching = (): void => {};
    const watchDensity = (): void => {
      const query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onChange = (): void => {
        resize();
        watchDensity();
      };
      query.addEventListener("change", onChange, { once: true });
      stopWatching = () => query.removeEventListener("change", onChange);
    };
    watchDensity();
    this.cleanups.push(() => stopWatching());

    resize();
  }

  private attachTheme(): void {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      this.theme = readTheme();
      this.requestDraw();
    };
    query.addEventListener("change", onChange);
    this.cleanups.push(() => query.removeEventListener("change", onChange));
  }

  // ---- pointer input -----------------------------------------------------

  private attachPointerInput(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
    ): void => {
      this.canvas.addEventListener(type, handler);
      this.cleanups.push(() => this.canvas.removeEventListener(type, handler));
    };

    on("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      this.canvas.setPointerCapture(event.pointerId);
      const point = this.pointFrom(event);
      this.sendCursor(point.x, point.y);
      this.apply(pointerDown(this.interaction, this.context(), point));
    });

    on("pointermove", (event) => {
      const point = this.pointFrom(event);
      this.lastPoint = point;
      this.sendCursor(point.x, point.y);
      if (this.interaction.kind === "idle") {
        this.canvas.style.cursor = cursorFor(this.interaction, this.context(), point);
        return;
      }
      this.apply(pointerMove(this.interaction, point, event.shiftKey));
    });

    on("pointerup", (event) => {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.apply(pointerUp(this.interaction, this.pointFrom(event), event.shiftKey));
    });

    on("pointercancel", () => this.cancelGesture());

    // Double click: label the shape under the pointer, or start new text on empty canvas.
    on("dblclick", (event) => {
      const effect = doubleClick(this.context(), this.pointFrom(event));
      if (effect) this.carryOut(effect);
    });
  }

  private pointFrom(event: MouseEvent): Point {
    const box = this.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  private context(): InteractionContext {
    return {
      tool: this.state.getTool(),
      shapes: orderedShapes(this.client.engine.getLiveShapes()),
      selectedId: this.state.getSelectedId(),
    };
  }

  private apply(step: Step): void {
    this.interaction = step.state;
    for (const effect of step.effects) this.carryOut(effect);
    this.canvas.style.cursor = cursorFor(this.interaction, this.context(), this.lastPoint);
    this.requestDraw();
  }

  private carryOut(effect: Effect): void {
    switch (effect.type) {
      case "select":
        this.state.setSelectedId(effect.shapeId);
        break;
      case "preview":
        this.sendPreview(effect.shapeId, effect.changes);
        break;
      case "update": {
        // The commit carries the final geometry; a preview still waiting to go out would only arrive after it, and show stale.
        this.sendPreview.cancel();
        this.client.updateShape(effect.shapeId, effect.changes);
        break;
      }
      case "create": {
        const result = this.client.createShape(effect.shape, {
          ...effect.rect,
          color: this.state.getColor(),
          text: "",
        });
        if (result.ok) {
          this.state.setSelectedId(result.op.shapeId);
          this.state.setTool("select");
        }
        break;
      }
      case "begin_text":
        this.beginTextDraft(effect.rect);
        break;
      case "edit_text":
        this.editText(effect.shapeId);
        break;
    }
  }

  // ---- text ----------------------------------------------------------------

  /** Opens the text box for the selected shape (the Enter key). */
  editSelected(): void {
    const selected = this.state.getSelectedId();
    if (selected) this.editText(selected);
  }

  private inkFor(kind: ShapeKind, color: string): string {
    const theme = this.theme;
    return kind === "text" ? shade(color, theme.textShade) : theme.shapeInk;
  }

  /** Runs after the current pointer event has finished, so the browser's own focus handling cannot take the text box's focus away. */
  private openSoon(open: () => void): void {
    window.setTimeout(open, 0);
  }

  private beginTextDraft(rect: Rect): void {
    this.state.setEditing({ kind: "draft", rect });
    this.openSoon(() =>
      this.editor.open(
        { kind: "text", rect, text: "", ink: this.inkFor("text", this.state.getColor()) },
        (text) => this.finishDraft(rect, text),
      ),
    );
  }

  private editText(shapeId: string): void {
    const shape = getShape(this.client.engine.getLiveShapes(), shapeId);
    if (!shape || isLinearKind(shape.kind)) return;
    const rect = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
    this.state.setSelectedId(shapeId);
    this.state.setEditing({ kind: "shape", shapeId });
    this.openSoon(() =>
      this.editor.open(
        { kind: shape.kind, rect, text: shape.text, ink: this.inkFor(shape.kind, shape.color) },
        (text) => this.finishEdit(shapeId, text),
      ),
    );
  }

  /** Height a text shape needs for `text` at `width`. */
  private textHeight(text: string, width: number): number {
    const ctx = this.measureContext;
    if (!ctx) return Math.round(text.split("\n").length * 26 + 12);
    ctx.font = fontFor("text");
    return textShapeHeight(text, width, (line) => ctx.measureText(line).width);
  }

  private finishDraft(rect: Rect, text: string | null): void {
    this.state.setEditing(null);
    if (text === null || text === "") return;
    const result = this.client.createShape("text", {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: this.textHeight(text, rect.width),
      color: this.state.getColor(),
      text,
    });
    if (result.ok) {
      this.state.setSelectedId(result.op.shapeId);
      this.state.setTool("select");
    }
  }

  private finishEdit(shapeId: string, text: string | null): void {
    this.state.setEditing(null);
    if (text === null) return;
    const shape = getShape(this.client.engine.getLiveShapes(), shapeId);
    if (!shape) return; // deleted by someone else while typing
    if (shape.kind !== "text") {
      if (text !== shape.text) this.client.updateShape(shapeId, { text });
      return;
    }
    // A text shape with nothing in it is nothing: remove it, as every editor does.
    if (text === "") {
      this.client.deleteShape(shapeId);
      this.state.setSelectedId(null);
      return;
    }
    const changes: ShapeChanges = {};
    if (text !== shape.text) changes.text = text;
    const height = this.textHeight(text, shape.width);
    if (height !== shape.height) changes.height = height;
    if (Object.keys(changes).length > 0) this.client.updateShape(shapeId, changes);
  }

  // ---- saving a picture ------------------------------------------------------

  /** Downloads the board as a PNG. Returns false when there is nothing on it. */
  async exportImage(): Promise<boolean> {
    const blob = await renderBoardImage(this.client.engine.getLiveShapes(), this.theme);
    if (!blob) return false;
    downloadBlob(blob, "whiteboard.png");
    return true;
  }
}
