import type { ShapeSnapshot } from "@realtime-canvas/shared";
import { SHAPE_KINDS, type ShapeFields, type ShapeKind } from "@realtime-canvas/shared";
import { sanitizeShape } from "./geometry";
import type { Tool } from "./interaction";

/**
 * Keyboard shortcuts and the small actions behind them, as plain functions so
 * the rules (which key means what, where a copy lands) are testable without
 * a keyboard.
 */

/** One letter per tool, shown in the toolbar tooltips and the help card. */
export const TOOL_KEYS: Record<Tool, string> = {
  select: "v",
  rect: "r",
  ellipse: "o",
  diamond: "d",
  triangle: "g",
  line: "l",
  arrow: "a",
  text: "t",
};

/** Human names for the tools and kinds, for tooltips and for screen readers. */
export const TOOL_NAMES: Record<Tool, string> = {
  select: "Select",
  rect: "Rectangle",
  ellipse: "Ellipse",
  diamond: "Diamond",
  triangle: "Triangle",
  line: "Line",
  arrow: "Arrow",
  text: "Text",
};

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  diamond: "Diamond",
  triangle: "Triangle",
  line: "Line",
  arrow: "Arrow",
  text: "Text",
};

export const ALL_TOOLS: readonly Tool[] = ["select", ...SHAPE_KINDS];

/** The tool a key chooses, or null. Upper and lower case are the same key. */
export function toolForKey(key: string): Tool | null {
  const lower = key.toLowerCase();
  return ALL_TOOLS.find((tool) => TOOL_KEYS[tool] === lower) ?? null;
}

/**
 * Whether a keyboard event is for a text box or field. Shortcuts must stay
 * out of the way then: typing "r" or Backspace into a label is typing.
 */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
}

/** How far a duplicate lands from the original, so it does not hide it. */
export const DUPLICATE_OFFSET = 24;

/** What to create for a copy of `shape`: the same kind and look, a little down and to the right. */
export function duplicateOf(shape: ShapeSnapshot): { kind: ShapeKind; fields: ShapeFields } {
  const moved = sanitizeShape(shape.kind, {
    x: shape.x + DUPLICATE_OFFSET,
    y: shape.y + DUPLICATE_OFFSET,
    width: shape.width,
    height: shape.height,
  });
  return { kind: shape.kind, fields: { ...moved, color: shape.color, text: shape.text } };
}
