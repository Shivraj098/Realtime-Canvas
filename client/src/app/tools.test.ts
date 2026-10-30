import { describe, expect, it } from "vitest";
import {
  cursorFor,
  DEFAULT_LINE_LENGTH,
  doubleClick,
  IDLE,
  creationGhost,
  pointerDown,
  pointerMove,
  pointerUp,
  type Effect,
  type Interaction,
  type InteractionContext,
  type Tool,
} from "./interaction";
import { DEFAULT_TEXT_WIDTH, minTextHeight } from "./text-layout";

const tool = (t: Tool, extra: Partial<InteractionContext> = {}): InteractionContext => ({
  tool: t,
  shapes: [],
  selectedId: null,
  ...extra,
});

function draw(
  ctx: InteractionContext,
  from: { x: number; y: number },
  to: { x: number; y: number },
  shift = false,
) {
  let step = pointerDown(IDLE, ctx, from);
  step = pointerMove(step.state, to, shift);
  return pointerUp(step.state, to, shift).effects;
}

describe("drawing each kind of shape", () => {
  it.each(["rect", "ellipse", "diamond", "triangle"] as const)(
    "a dragged %s is the box between the two corners",
    (kind) => {
      expect(draw(tool(kind), { x: 200, y: 150 }, { x: 100, y: 50 })).toEqual([
        { type: "create", shape: kind, rect: { x: 100, y: 50, width: 100, height: 100 } },
      ]);
    },
  );

  it.each(["rect", "ellipse", "diamond", "triangle"] as const)(
    "a click makes a default-size %s centred on it",
    (kind) => {
      const [effect] = draw(tool(kind), { x: 300, y: 300 }, { x: 300, y: 300 });
      expect(effect).toMatchObject({
        type: "create",
        shape: kind,
        rect: { x: 240, y: 260, width: 120, height: 80 },
      });
    },
  );

  it("Shift makes a box square, on the side the pointer is on", () => {
    expect(draw(tool("ellipse"), { x: 100, y: 100 }, { x: 180, y: 130 }, true)).toEqual([
      { type: "create", shape: "ellipse", rect: { x: 100, y: 100, width: 80, height: 80 } },
    ]);
    expect(draw(tool("ellipse"), { x: 100, y: 100 }, { x: 40, y: 70 }, true)).toEqual([
      { type: "create", shape: "ellipse", rect: { x: 40, y: 40, width: 60, height: 60 } },
    ]);
  });
});

describe("drawing lines and arrows", () => {
  it.each(["line", "arrow"] as const)(
    "a dragged %s keeps its direction: start where pressed, vector to where released",
    (kind) => {
      expect(draw(tool(kind), { x: 200, y: 200 }, { x: 120, y: 260 })).toEqual([
        { type: "create", shape: kind, rect: { x: 200, y: 200, width: -80, height: 60 } },
      ]);
    },
  );

  it("a click makes a horizontal line of the default length, centred on the click", () => {
    expect(draw(tool("arrow"), { x: 300, y: 300 }, { x: 300, y: 300 })).toEqual([
      {
        type: "create",
        shape: "arrow",
        rect: { x: 300 - DEFAULT_LINE_LENGTH / 2, y: 300, width: DEFAULT_LINE_LENGTH, height: 0 },
      },
    ]);
  });

  it("a drag shorter than the minimum is treated as a click", () => {
    const [effect] = draw(tool("line"), { x: 100, y: 100 }, { x: 105, y: 102 });
    expect(effect).toMatchObject({ rect: { width: DEFAULT_LINE_LENGTH, height: 0 } });
  });

  it("Shift snaps the line to a multiple of 45 degrees", () => {
    const [effect] = draw(tool("line"), { x: 0, y: 0 }, { x: 100, y: 12 }, true);
    expect(effect).toMatchObject({ type: "create", rect: { x: 0, y: 0, height: 0 } });
    const [diagonal] = draw(tool("line"), { x: 0, y: 0 }, { x: 60, y: 70 }, true);
    const rect = (diagonal as Extract<Effect, { type: "create" }>).rect;
    expect(Math.abs(rect.width - rect.height)).toBeLessThanOrEqual(1);
  });

  it("the outline while drawing is the vector, not a normalised box", () => {
    let step = pointerDown(IDLE, tool("arrow"), { x: 50, y: 50 });
    step = pointerMove(step.state, { x: 10, y: 20 });
    expect(creationGhost(step.state)).toEqual({
      kind: "arrow",
      rect: { x: 50, y: 50, width: -40, height: -30 },
    });
  });
});

describe("the text tool", () => {
  it("a click asks for a text box of the default size at the click, and creates nothing yet", () => {
    expect(draw(tool("text"), { x: 80, y: 90 }, { x: 80, y: 90 })).toEqual([
      { type: "begin_text", rect: { x: 80, y: 90, width: DEFAULT_TEXT_WIDTH, height: minTextHeight() } },
    ]);
  });

  it("a drag sets the width of the box", () => {
    expect(draw(tool("text"), { x: 80, y: 90 }, { x: 330, y: 200 })).toEqual([
      { type: "begin_text", rect: { x: 80, y: 90, width: 250, height: minTextHeight() } },
    ]);
  });

  it("a narrow drag falls back to the default width", () => {
    const [effect] = draw(tool("text"), { x: 80, y: 90 }, { x: 85, y: 200 });
    expect(effect).toMatchObject({ rect: { width: DEFAULT_TEXT_WIDTH } });
  });
});

describe("moving and resizing lines and arrows", () => {
  const arrow = { id: "ar", kind: "arrow" as const, rect: { x: 100, y: 100, width: 100, height: 0 } };
  const ctx = tool("select", { shapes: [arrow], selectedId: "ar" });

  it("grabbing an end of the selected arrow resizes it, and the update is one op with the new vector", () => {
    let step = pointerDown(IDLE, ctx, { x: 200, y: 100 });
    expect(step.state).toMatchObject({ kind: "resizing", handle: "end" });
    step = pointerMove(step.state, { x: 250, y: 160 });
    expect(step.effects).toEqual([
      { type: "preview", shapeId: "ar", changes: { x: 100, y: 100, width: 150, height: 60 } },
    ]);
    expect(pointerUp(step.state, { x: 250, y: 160 }).effects).toEqual([
      { type: "update", shapeId: "ar", changes: { width: 150, height: 60 } },
    ]);
  });

  it("dragging the start end changes x, y and the vector together", () => {
    const step = pointerDown(IDLE, ctx, { x: 100, y: 100 });
    const up = pointerUp(step.state, { x: 80, y: 90 });
    expect(up.effects).toEqual([
      { type: "update", shapeId: "ar", changes: { x: 80, y: 90, width: 120, height: 10 } },
    ]);
  });

  it("Shift while dragging an end snaps the arrow to 45 degrees around the end that stays put", () => {
    const step = pointerDown(IDLE, ctx, { x: 200, y: 100 });
    const [update] = pointerUp(step.state, { x: 260, y: 112 }, true).effects;
    const changes = (update as Extract<Effect, { type: "update" }>).changes;
    expect(changes.height).toBeUndefined(); // still level with the fixed end, so unchanged
    expect(changes.width).toBeGreaterThan(100);
  });

  it("dragging the middle of an arrow moves it without changing its vector", () => {
    let step = pointerDown(IDLE, ctx, { x: 150, y: 101 });
    expect(step.state.kind).toBe("moving");
    step = pointerMove(step.state, { x: 170, y: 141 });
    expect(pointerUp(step.state, { x: 170, y: 141 }).effects).toEqual([
      { type: "update", shapeId: "ar", changes: { x: 120, y: 140 } },
    ]);
  });

  it("Shift while moving keeps to the dominant axis", () => {
    const step = pointerDown(IDLE, ctx, { x: 150, y: 101 });
    const moved = pointerMove(step.state, { x: 190, y: 111 }, true);
    expect(moved.effects).toEqual([{ type: "preview", shapeId: "ar", changes: { x: 140, y: 100 } }]);
  });

  it("clicking beside an arrow misses it; clicking on it selects it", () => {
    expect(pointerDown(IDLE, tool("select", { shapes: [arrow] }), { x: 150, y: 130 }).state.kind).toBe(
      "idle",
    );
    expect(pointerDown(IDLE, tool("select", { shapes: [arrow] }), { x: 150, y: 103 }).effects).toEqual([
      { type: "select", shapeId: "ar" },
    ]);
  });
});

describe("double click", () => {
  const shapes = [
    { id: "r", kind: "rect" as const, rect: { x: 0, y: 0, width: 100, height: 100 } },
    { id: "l", kind: "line" as const, rect: { x: 300, y: 300, width: 100, height: 0 } },
    { id: "t", kind: "text" as const, rect: { x: 500, y: 0, width: 100, height: 30 } },
  ];
  const ctx = tool("select", { shapes });

  it("edits the text of a box, an ellipse or a text shape", () => {
    expect(doubleClick(ctx, { x: 50, y: 50 })).toEqual({ type: "edit_text", shapeId: "r" });
    expect(doubleClick(ctx, { x: 520, y: 10 })).toEqual({ type: "edit_text", shapeId: "t" });
  });

  it("does nothing on a line or arrow, which have no text", () => {
    expect(doubleClick(ctx, { x: 350, y: 301 })).toBeNull();
  });

  it("starts a new piece of text on empty canvas", () => {
    expect(doubleClick(ctx, { x: 700, y: 700 })).toEqual({
      type: "begin_text",
      rect: { x: 700, y: 700, width: DEFAULT_TEXT_WIDTH, height: minTextHeight() },
    });
  });
});

describe("cursorFor", () => {
  const rectShape = { id: "r", kind: "rect" as const, rect: { x: 100, y: 100, width: 100, height: 100 } };
  const select = tool("select", { shapes: [rectShape], selectedId: "r" });

  it("is a crosshair for a drawing tool, and a text cursor for the text tool", () => {
    expect(cursorFor(IDLE, tool("ellipse"), null)).toBe("crosshair");
    expect(cursorFor(IDLE, tool("text"), null)).toBe("text");
  });

  it("shows what is under the pointer when selecting", () => {
    expect(cursorFor(IDLE, select, { x: 150, y: 150 })).toBe("move");
    expect(cursorFor(IDLE, select, { x: 600, y: 600 })).toBe("default");
    expect(cursorFor(IDLE, select, { x: 100, y: 100 })).toBe("nwse-resize");
    expect(cursorFor(IDLE, select, { x: 200, y: 100 })).toBe("nesw-resize");
    expect(cursorFor(IDLE, select, null)).toBe("default");
  });

  it("while a gesture is going, shows what the gesture is", () => {
    const creating: Interaction = {
      kind: "creating",
      shape: "rect",
      constrain: false,
      origin: { x: 0, y: 0 },
      current: { x: 5, y: 5 },
    };
    expect(cursorFor(creating, select, null)).toBe("crosshair");
    const moving = pointerDown(IDLE, select, { x: 150, y: 150 }).state;
    expect(cursorFor(moving, select, null)).toBe("move");
    expect(cursorFor(pointerMove(moving, { x: 190, y: 190 }).state, select, null)).toBe("grabbing");
    expect(cursorFor(pointerDown(IDLE, select, { x: 200, y: 200 }).state, select, null)).toBe("nwse-resize");
  });
});
