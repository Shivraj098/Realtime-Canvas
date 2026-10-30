import { describe, expect, it } from "vitest";
import type { HlcTimestamp, RoomState, ShapeSnapshot } from "@realtime-canvas/shared";
import { IDLE, type Interaction } from "./interaction";
import { buildExportScene, buildScene, labelFor, orderedShapes, type SceneInput } from "./scene";

const at: HlcTimestamp = { physical: 1, logical: 0, nodeId: "server" };

function shape(x: number, y: number, color = "#336699", width = 100, height = 50): ShapeSnapshot {
  return {
    kind: "rect",
    x,
    y,
    width,
    height,
    color,
    text: "",
    lastHlc: { x: at, y: at, width: at, height: at, color: at, text: at },
  };
}

const live: RoomState = { a: shape(0, 0, "#111111"), b: shape(200, 0, "#222222") };

function input(overrides: Partial<SceneInput> = {}): SceneInput {
  return {
    liveShapes: live,
    previews: [],
    presence: [
      { clientId: "me", color: "#00ff00" },
      { clientId: "rival", color: "#ff0000" },
    ],
    interaction: IDLE,
    selectedId: null,
    newShapeColor: "#abcdef",
    cursors: [],
    ...overrides,
  };
}

describe("orderedShapes", () => {
  it("lists shapes back to front in the order they were created", () => {
    expect(orderedShapes(live).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("keeps a shape whose id collides with Object.prototype members", () => {
    expect(orderedShapes({ constructor: shape(0, 0) }).map((s) => s.id)).toEqual(["constructor"]);
  });
});

describe("buildScene", () => {
  it("draws every live shape where the room has it", () => {
    const scene = buildScene(input());
    expect(scene.shapes).toEqual([
      {
        id: "a",
        kind: "rect",
        text: "",
        rect: { x: 0, y: 0, width: 100, height: 50 },
        color: "#111111",
        mode: "normal",
      },
      {
        id: "b",
        kind: "rect",
        text: "",
        rect: { x: 200, y: 0, width: 100, height: 50 },
        color: "#222222",
        mode: "normal",
      },
    ]);
    expect(scene.selection).toBeNull();
    expect(scene.ghost).toBeNull();
    expect(scene.cursors).toEqual([]);
  });

  it("outlines the selected shape", () => {
    expect(buildScene(input({ selectedId: "b" })).selection?.rect).toEqual({
      x: 200,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it("shows nothing selected when the selected shape no longer exists", () => {
    expect(buildScene(input({ selectedId: "deleted-by-someone" })).selection).toBeNull();
  });

  it("draws a shape being dragged at the dragged position, and the selection follows it", () => {
    const interaction: Interaction = {
      kind: "moving",
      shapeId: "a",
      shape: "rect",
      start: { x: 0, y: 0, width: 100, height: 50 },
      origin: { x: 10, y: 10 },
      current: { x: 30, y: 40, width: 100, height: 50 },
      dragged: true,
    };
    const scene = buildScene(input({ interaction, selectedId: "a" }));
    expect(scene.shapes[0]).toMatchObject({ id: "a", mode: "dragging", rect: { x: 30, y: 40 } });
    expect(scene.selection?.rect).toEqual({ x: 30, y: 40, width: 100, height: 50 });
  });

  it("draws a shape someone else is dragging at their preview position, in their colour", () => {
    const scene = buildScene(
      input({
        previews: [{ clientId: "rival", shapeId: "b", changes: { x: 250, y: 20 }, receivedAt: 0 }],
      }),
    );
    expect(scene.shapes[1]).toMatchObject({
      id: "b",
      mode: "remote-preview",
      ownerColor: "#ff0000",
      rect: { x: 250, y: 20, width: 100, height: 50 },
    });
    expect(scene.shapes[0]!.mode).toBe("normal");
  });

  it("applies only the fields a preview carries", () => {
    const scene = buildScene(
      input({ previews: [{ clientId: "rival", shapeId: "a", changes: { width: 300 }, receivedAt: 0 }] }),
    );
    expect(scene.shapes[0]!.rect).toEqual({ x: 0, y: 0, width: 300, height: 50 });
  });

  it("uses the most recent preview when two people drag the same shape", () => {
    const scene = buildScene(
      input({
        previews: [
          { clientId: "me", shapeId: "a", changes: { x: 1 }, receivedAt: 0 },
          { clientId: "rival", shapeId: "a", changes: { x: 2 }, receivedAt: 1 },
        ],
      }),
    );
    expect(scene.shapes[0]!.rect.x).toBe(2);
  });

  it("falls back to a neutral colour for a preview from someone not in the presence list", () => {
    const scene = buildScene(
      input({ previews: [{ clientId: "ghost", shapeId: "a", changes: { x: 5 }, receivedAt: 0 }] }),
    );
    expect(scene.shapes[0]!.ownerColor).toBe("#8a8a8a");
  });

  it("ignores a preview for a shape that is not drawn", () => {
    const scene = buildScene(
      input({ previews: [{ clientId: "rival", shapeId: "nope", changes: { x: 5 }, receivedAt: 0 }] }),
    );
    expect(scene.shapes.every((s) => s.mode === "normal")).toBe(true);
  });

  it("shows the outline of a rectangle being drawn, in the colour it will get", () => {
    const interaction: Interaction = {
      kind: "creating",
      shape: "rect",
      constrain: false,
      origin: { x: 50, y: 60 },
      current: { x: 10, y: 20 },
    };
    expect(buildScene(input({ interaction })).ghost).toEqual({
      kind: "rect",
      rect: { x: 10, y: 20, width: 40, height: 40 },
      color: "#abcdef",
    });
  });

  it("labels each cursor with the start of its client id", () => {
    const scene = buildScene(input({ cursors: [{ clientId: "abcdef-1234", x: 5, y: 6, color: "#fff" }] }));
    expect(scene.cursors).toEqual([{ clientId: "abcdef-1234", x: 5, y: 6, color: "#fff", label: "abcd" }]);
    expect(labelFor("xy")).toBe("xy");
  });
});

describe("buildScene: kinds, text, editing and animation", () => {
  const withKinds: RoomState = {
    r: { ...shape(10, 10), kind: "ellipse", text: "hello" },
    l: { ...shape(50, 60, "#000000", -40, 30), kind: "arrow" },
  };
  const base = (extra: Partial<Parameters<typeof buildScene>[0]> = {}) => ({
    liveShapes: withKinds,
    previews: [],
    presence: [],
    interaction: IDLE,
    selectedId: null,
    newShapeColor: "#abcdef",
    cursors: [],
    ...extra,
  });

  it("carries each shape's kind and text, and a line's signed vector", () => {
    const { shapes } = buildScene(base());
    expect(shapes[0]).toMatchObject({ kind: "ellipse", text: "hello" });
    expect(shapes[1]).toMatchObject({ kind: "arrow", rect: { x: 50, y: 60, width: -40, height: 30 } });
  });

  it("marks the shape being edited, and carries pop-in progress and the open text draft", () => {
    const scene = buildScene(
      base({ editingId: "r", appearing: new Map([["l", 0.5]]), draft: { x: 1, y: 2, width: 3, height: 4 } }),
    );
    expect(scene.shapes[0]!.editing).toBe(true);
    expect(scene.shapes[1]!.editing).toBeUndefined();
    expect(scene.shapes[1]!.appear).toBe(0.5);
    expect(scene.draft).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("selects a line by its kind so the handles go on its ends", () => {
    expect(buildScene(base({ selectedId: "l" })).selection?.kind).toBe("arrow");
  });

  it("shows an arrow being drawn as a vector, with Shift snapping it to 45 degrees", () => {
    const interaction: Interaction = {
      kind: "creating",
      shape: "arrow",
      constrain: true,
      origin: { x: 0, y: 0 },
      current: { x: 100, y: 10 },
    };
    const ghost = buildScene(base({ interaction })).ghost!;
    expect(ghost.kind).toBe("arrow");
    expect(ghost.rect.height).toBeCloseTo(0);
    expect(ghost.rect.width).toBeCloseTo(Math.hypot(100, 10));
  });
});

describe("buildExportScene", () => {
  it("is null for an empty board", () => {
    expect(buildExportScene({})).toBeNull();
  });

  it("moves everything so the drawing starts at the padding, and sizes the picture to fit, lines included", () => {
    const built = buildExportScene({
      a: { ...shape(100, 100, "#111111", 50, 40), kind: "rect" },
      l: { ...shape(200, 300, "#000000", -80, -20), kind: "line" },
    })!;
    // Bounds: x 120..200+... left=100, right=max(150,200)=200, top=100, bottom=max(140,300)=300.
    expect(built.width).toBe(100 + 64);
    expect(built.height).toBe(200 + 64);
    expect(built.scene.shapes[0]!.rect).toMatchObject({ x: 32, y: 32 });
    expect(built.scene.shapes[1]!.rect).toMatchObject({ x: 132, y: 232, width: -80, height: -20 });
    expect(built.scene.selection).toBeNull();
    expect(built.scene.cursors).toEqual([]);
  });
});
