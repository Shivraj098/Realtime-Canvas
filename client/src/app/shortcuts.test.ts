import { describe, expect, it } from "vitest";
import type { ShapeSnapshot } from "@realtime-canvas/shared";
import {
  ALL_TOOLS,
  DUPLICATE_OFFSET,
  duplicateOf,
  isTypingTarget,
  SHAPE_NAMES,
  TOOL_KEYS,
  TOOL_NAMES,
  toolForKey,
} from "./shortcuts";

const at = { physical: 1, logical: 0, nodeId: "server" };
const snapshot = (over: Partial<ShapeSnapshot> = {}): ShapeSnapshot => ({
  kind: "ellipse",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  color: "#123456",
  text: "hi",
  lastHlc: { x: at, y: at, width: at, height: at, color: at, text: at },
  ...over,
});

describe("tool keys", () => {
  it("gives every tool its own key and its own name", () => {
    expect(new Set(ALL_TOOLS.map((tool) => TOOL_KEYS[tool])).size).toBe(ALL_TOOLS.length);
    expect(new Set(ALL_TOOLS.map((tool) => TOOL_NAMES[tool])).size).toBe(ALL_TOOLS.length);
  });

  it("finds the tool for a key, in either case, and nothing for other keys", () => {
    expect(toolForKey("r")).toBe("rect");
    expect(toolForKey("A")).toBe("arrow");
    expect(toolForKey("v")).toBe("select");
    expect(toolForKey("x")).toBeNull();
    expect(toolForKey("Enter")).toBeNull();
  });

  it("names every kind of shape", () => {
    for (const tool of ALL_TOOLS) if (tool !== "select") expect(SHAPE_NAMES[tool]).toBeTruthy();
  });
});

describe("isTypingTarget", () => {
  it("is true for text fields and editable content, false for everything else", () => {
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "CANVAS" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("duplicateOf", () => {
  it("copies kind, size, colour and text, a little down and to the right", () => {
    expect(duplicateOf(snapshot())).toEqual({
      kind: "ellipse",
      fields: {
        x: 10 + DUPLICATE_OFFSET,
        y: 20 + DUPLICATE_OFFSET,
        width: 100,
        height: 50,
        color: "#123456",
        text: "hi",
      },
    });
  });

  it("keeps the direction of a line", () => {
    const copy = duplicateOf(snapshot({ kind: "arrow", width: -80, height: -30, text: "" }));
    expect(copy.fields).toMatchObject({ width: -80, height: -30 });
  });

  it("never copies the edit history: the copy is a brand new shape", () => {
    expect(duplicateOf(snapshot())).not.toHaveProperty("lastHlc");
    expect(duplicateOf(snapshot()).fields).not.toHaveProperty("lastHlc");
  });

  it("stays inside the world", () => {
    expect(duplicateOf(snapshot({ x: 999_999 })).fields.x).toBe(1_000_000);
  });
});
