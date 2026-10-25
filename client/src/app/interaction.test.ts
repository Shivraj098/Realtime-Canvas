import { describe, expect, it } from "vitest";
import type { Rect } from "./geometry";
import {
  cancel,
  creationGhost,
  DEFAULT_SIZE,
  DRAG_THRESHOLD,
  dragOverride,
  IDLE,
  pointerDown,
  pointerMove,
  pointerUp,
  type Effect,
  type Interaction,
  type InteractionContext,
} from "./interaction";

const box: Rect = { x: 100, y: 100, width: 200, height: 100 };
const other: Rect = { x: 500, y: 500, width: 50, height: 50 };

const select = (selectedId: string | null = null): InteractionContext => ({
  tool: "select",
  shapes: [
    { id: "box", rect: box },
    { id: "other", rect: other },
  ],
  selectedId,
});
const rectangleTool: InteractionContext = { tool: "rectangle", shapes: [], selectedId: null };

/** Runs a whole gesture and returns every effect, in order. */
function gesture(
  ctx: InteractionContext,
  points: { x: number; y: number }[],
): { effects: Effect[]; state: Interaction } {
  let state: Interaction = IDLE;
  const effects: Effect[] = [];
  points.forEach((point, index) => {
    const step =
      index === 0
        ? pointerDown(state, ctx, point)
        : index === points.length - 1
          ? pointerUp(state, point)
          : pointerMove(state, point);
    state = step.state;
    effects.push(...step.effects);
  });
  return { effects, state };
}

describe("selecting", () => {
  it("selects the shape under a press and starts moving it", () => {
    const step = pointerDown(IDLE, select(), { x: 150, y: 150 });
    expect(step.effects).toEqual([{ type: "select", shapeId: "box" }]);
    expect(step.state.kind).toBe("moving");
  });

  it("clears the selection when pressing empty space", () => {
    const step = pointerDown(IDLE, select("box"), { x: 900, y: 900 });
    expect(step.effects).toEqual([{ type: "select", shapeId: null }]);
    expect(step.state).toEqual(IDLE);
  });

  it("a click without movement selects and commits nothing", () => {
    const { effects, state } = gesture(select(), [
      { x: 150, y: 150 },
      { x: 151, y: 150 },
      { x: 151, y: 150 },
    ]);
    expect(effects).toEqual([{ type: "select", shapeId: "box" }]);
    expect(state).toEqual(IDLE);
  });
});

describe("moving", () => {
  it("previews on every move once past the threshold, and commits ONE update on release", () => {
    const { effects } = gesture(select(), [
      { x: 150, y: 150 },
      { x: 160, y: 150 },
      { x: 170, y: 160 },
      { x: 180, y: 170 },
      { x: 180, y: 170 },
    ]);
    expect(effects.filter((e) => e.type === "preview")).toHaveLength(3);
    expect(effects.filter((e) => e.type === "update")).toEqual([
      { type: "update", shapeId: "box", changes: { x: 130, y: 120 } },
    ]);
  });

  it("does not preview movement below the drag threshold", () => {
    const step = pointerMove(pointerDown(IDLE, select(), { x: 150, y: 150 }).state, {
      x: 150 + DRAG_THRESHOLD - 1,
      y: 150,
    });
    expect(step.effects).toEqual([]);
    expect(dragOverride(step.state)).toBeNull();
  });

  it("once dragging has started, small moves keep previewing", () => {
    let state = pointerDown(IDLE, select(), { x: 150, y: 150 }).state;
    state = pointerMove(state, { x: 170, y: 150 }).state;
    const step = pointerMove(state, { x: 171, y: 150 });
    expect(step.effects).toHaveLength(1);
  });

  it("sends only the fields that changed", () => {
    const { effects } = gesture(select(), [
      { x: 150, y: 150 },
      { x: 150, y: 170 },
      { x: 150, y: 170 },
    ]);
    expect(effects.find((e) => e.type === "update")).toEqual({
      type: "update",
      shapeId: "box",
      changes: { y: 120 },
    });
  });

  it("commits nothing when the shape is dragged back to where it started", () => {
    const { effects } = gesture(select(), [
      { x: 150, y: 150 },
      { x: 200, y: 200 },
      { x: 150, y: 150 },
    ]);
    expect(effects.some((e) => e.type === "update")).toBe(false);
  });

  it("shows the shape at the dragged position while the gesture is in progress", () => {
    let state = pointerDown(IDLE, select(), { x: 150, y: 150 }).state;
    state = pointerMove(state, { x: 180, y: 190 }).state;
    expect(dragOverride(state)).toEqual({
      shapeId: "box",
      rect: { x: 130, y: 140, width: 200, height: 100 },
    });
  });

  it("rounds the committed position to whole pixels", () => {
    const { effects } = gesture(select(), [
      { x: 150, y: 150 },
      { x: 160.4, y: 150 },
      { x: 160.4, y: 150 },
    ]);
    expect(effects.find((e) => e.type === "update")).toEqual({
      type: "update",
      shapeId: "box",
      changes: { x: 110 },
    });
  });
});

describe("releasing", () => {
  it("commits where the pointer was released, even if that differs from the last move event", () => {
    const { effects } = gesture(select(), [
      { x: 150, y: 150 },
      { x: 160, y: 150 },
      { x: 190, y: 150 },
    ]);
    expect(effects.find((e) => e.type === "update")).toEqual({
      type: "update",
      shapeId: "box",
      changes: { x: 140 },
    });
  });

  it("treats a press-and-release that never moved as a click even if the last move event was a drag", () => {
    const down = pointerDown(IDLE, select(), { x: 150, y: 150 });
    expect(pointerUp(down.state, { x: 150, y: 150 }).effects).toEqual([]);
  });

  it("commits a resize at the release point too", () => {
    const { effects } = gesture(select("box"), [
      { x: 300, y: 200 },
      { x: 310, y: 205 },
      { x: 360, y: 230 },
    ]);
    expect(effects.find((e) => e.type === "update")).toEqual({
      type: "update",
      shapeId: "box",
      changes: { width: 260, height: 130 },
    });
  });
});

describe("resizing", () => {
  it("grabs a handle of the selected shape and commits one update on release", () => {
    const { effects } = gesture(select("box"), [
      { x: 300, y: 200 }, // the south-east handle
      { x: 320, y: 210 },
      { x: 340, y: 220 },
    ]);
    expect(effects.filter((e) => e.type === "update")).toEqual([
      { type: "update", shapeId: "box", changes: { width: 240, height: 120 } },
    ]);
  });

  it("previews the full geometry while resizing", () => {
    let state = pointerDown(IDLE, select("box"), { x: 100, y: 100 }).state; // north-west handle
    const step = pointerMove(state, { x: 110, y: 120 });
    state = step.state;
    expect(step.effects).toEqual([
      { type: "preview", shapeId: "box", changes: { x: 110, y: 120, width: 190, height: 80 } },
    ]);
    expect(dragOverride(state)?.rect).toEqual({ x: 110, y: 120, width: 190, height: 80 });
  });

  it("only offers handles on the selected shape", () => {
    const step = pointerDown(IDLE, select(null), { x: 300, y: 200 });
    expect(step.state.kind).toBe("moving"); // pressed the shape's corner, but it was not selected
  });
});

describe("creating", () => {
  it("drawing a rectangle commits one create with the dragged geometry", () => {
    const { effects } = gesture(rectangleTool, [
      { x: 300, y: 300 },
      { x: 350, y: 340 },
      { x: 420, y: 380 },
    ]);
    expect(effects.filter((e) => e.type === "create")).toEqual([
      { type: "create", rect: { x: 300, y: 300, width: 120, height: 80 } },
    ]);
  });

  it("works when dragging up and to the left", () => {
    const { effects } = gesture(rectangleTool, [
      { x: 420, y: 380 },
      { x: 300, y: 300 },
    ]);
    expect(effects.find((e) => e.type === "create")).toEqual({
      type: "create",
      rect: { x: 300, y: 300, width: 120, height: 80 },
    });
  });

  it("a plain click makes a default-sized rectangle centred on the click", () => {
    const { effects } = gesture(rectangleTool, [
      { x: 400, y: 300 },
      { x: 400, y: 300 },
    ]);
    expect(effects.find((e) => e.type === "create")).toEqual({
      type: "create",
      rect: { x: 400 - DEFAULT_SIZE.width / 2, y: 300 - DEFAULT_SIZE.height / 2, ...DEFAULT_SIZE },
    });
  });

  it("falls back to the default size when the drag is too thin to be a usable shape", () => {
    const { effects } = gesture(rectangleTool, [
      { x: 400, y: 300 },
      { x: 500, y: 302 },
    ]);
    const created = effects.find((e) => e.type === "create");
    expect(created && created.type === "create" && created.rect.width).toBe(DEFAULT_SIZE.width);
  });

  it("deselects when a new rectangle starts, and exposes the outline being drawn", () => {
    const down = pointerDown(IDLE, rectangleTool, { x: 10, y: 10 });
    expect(down.effects).toEqual([{ type: "select", shapeId: null }]);
    const moved = pointerMove(down.state, { x: 60, y: 50 });
    expect(creationGhost(moved.state)).toEqual({ x: 10, y: 10, width: 50, height: 40 });
    expect(moved.effects).toEqual([]); // nothing is previewed: the shape does not exist yet
  });
});

describe("cancel and stray events", () => {
  it("escape abandons a gesture without committing anything", () => {
    let state = pointerDown(IDLE, select(), { x: 150, y: 150 }).state;
    state = pointerMove(state, { x: 250, y: 250 }).state;
    expect(dragOverride(state)).not.toBeNull(); // really mid-drag

    const step = cancel();
    expect(step.effects).toEqual([]); // nothing is sent
    expect(step.state).toEqual(IDLE);
    expect(dragOverride(step.state)).toBeNull(); // and the shape returns to where the room has it
  });

  it("ignores a second press while a gesture is in progress", () => {
    const first = pointerDown(IDLE, select(), { x: 150, y: 150 });
    const second = pointerDown(first.state, select(), { x: 600, y: 600 });
    expect(second.state).toBe(first.state);
    expect(second.effects).toEqual([]);
  });

  it("ignores moves and releases when idle", () => {
    expect(pointerMove(IDLE, { x: 1, y: 1 })).toEqual({ state: IDLE, effects: [] });
    expect(pointerUp(IDLE, { x: 1, y: 1 })).toEqual({ state: IDLE, effects: [] });
  });

  it("has no override or ghost while idle", () => {
    expect(dragOverride(IDLE)).toBeNull();
    expect(creationGhost(IDLE)).toBeNull();
  });
});
