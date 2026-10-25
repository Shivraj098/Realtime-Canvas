import type { GeometryChanges } from "@realtime-canvas/shared";
import type { RoomClient } from "../room-client";
import { realScheduler } from "../net/types";
import { hitHandle, hitTest, type Point } from "./geometry";
import {
  cancel,
  IDLE,
  pointerDown,
  pointerMove,
  pointerUp,
  type Effect,
  type Interaction,
  type InteractionContext,
  type Step,
} from "./interaction";
import { drawScene, type Theme } from "./render";
import { buildScene, orderedShapes } from "./scene";
import { CursorSmoother } from "./smoothing";
import type { AppState } from "./state";
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
  private readonly cleanups: (() => void)[] = [];
  private readonly sendCursor;
  private readonly sendPreview;

  private interaction: Interaction = IDLE;
  private theme: Theme = readTheme();
  private size = { width: 0, height: 0, dpr: 1 };
  private frameRequest: number | null = null;
  private lastFrameTime: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly client: RoomClient,
    private readonly state: AppState,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot draw on a canvas");
    this.ctx = ctx;

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
    const scene = buildScene({
      liveShapes: live,
      previews: engine.getPreviews(),
      presence: engine.getPresence(),
      interaction: this.interaction,
      selectedId: this.state.getSelectedId(),
      newShapeColor: this.state.getColor(),
      cursors,
    });
    drawScene(this.ctx, scene, this.theme, this.size);

    // Exposed so tests can see that remote cursors are being drawn.
    this.canvas.dataset.remoteCursors = String(cursors.length);

    const animating = this.smoother.isAnimating(targets) || engine.getPreviews().length > 0;
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
      this.sendCursor(point.x, point.y);
      if (this.interaction.kind === "idle") {
        this.updateHoverCursor(point);
        return;
      }
      this.apply(pointerMove(this.interaction, point));
    });

    on("pointerup", (event) => {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.apply(pointerUp(this.interaction, this.pointFrom(event)));
    });

    on("pointercancel", () => this.cancelGesture());
  }

  private pointFrom(event: PointerEvent): Point {
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
    this.canvas.style.cursor = this.interaction.kind === "idle" ? this.canvas.style.cursor : "grabbing";
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
        const result = this.client.createShape({ ...effect.rect, color: this.state.getColor() });
        if (result.ok) {
          this.state.setSelectedId(result.op.shapeId);
          this.state.setTool("select");
        }
        break;
      }
    }
  }

  private updateHoverCursor(point: Point): void {
    const { tool, selectedId, shapes } = this.context();
    let cursor = "default";
    if (tool === "rectangle") {
      cursor = "crosshair";
    } else {
      const selected = selectedId ? shapes.find((shape) => shape.id === selectedId) : undefined;
      const handle = selected ? hitHandle(selected.rect, point) : null;
      if (handle) cursor = handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize";
      else if (hitTest(shapes, point)) cursor = "move";
    }
    this.canvas.style.cursor = cursor;
  }
}
