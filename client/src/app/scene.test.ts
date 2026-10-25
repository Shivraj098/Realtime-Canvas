import { describe, expect, it } from "vitest";
import type { HlcTimestamp, RoomState, ShapeSnapshot } from "@realtime-canvas/shared";
import { IDLE, type Interaction } from "./interaction";
import { buildScene, labelFor, orderedShapes, type SceneInput } from "./scene";

const at: HlcTimestamp = { physical: 1, logical: 0, nodeId: "server" };

function shape(x: number, y: number, color = "#336699", width = 100, height = 50): ShapeSnapshot {
  return { x, y, width, height, color, lastHlc: { x: at, y: at, width: at, height: at, color: at } };
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
      { id: "a", rect: { x: 0, y: 0, width: 100, height: 50 }, color: "#111111", mode: "normal" },
      { id: "b", rect: { x: 200, y: 0, width: 100, height: 50 }, color: "#222222", mode: "normal" },
    ]);
    expect(scene.selectedRect).toBeNull();
    expect(scene.ghost).toBeNull();
    expect(scene.cursors).toEqual([]);
  });

  it("outlines the selected shape", () => {
    expect(buildScene(input({ selectedId: "b" })).selectedRect).toEqual({
      x: 200,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it("shows nothing selected when the selected shape no longer exists", () => {
    expect(buildScene(input({ selectedId: "deleted-by-someone" })).selectedRect).toBeNull();
  });

  it("draws a shape being dragged at the dragged position, and the selection follows it", () => {
    const interaction: Interaction = {
      kind: "moving",
      shapeId: "a",
      start: { x: 0, y: 0, width: 100, height: 50 },
      origin: { x: 10, y: 10 },
      current: { x: 30, y: 40, width: 100, height: 50 },
      dragged: true,
    };
    const scene = buildScene(input({ interaction, selectedId: "a" }));
    expect(scene.shapes[0]).toMatchObject({ id: "a", mode: "dragging", rect: { x: 30, y: 40 } });
    expect(scene.selectedRect).toEqual({ x: 30, y: 40, width: 100, height: 50 });
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
      origin: { x: 50, y: 60 },
      current: { x: 10, y: 20 },
    };
    expect(buildScene(input({ interaction })).ghost).toEqual({
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
