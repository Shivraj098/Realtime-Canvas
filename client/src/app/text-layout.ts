import { isLinearKind, type ShapeKind } from "@realtime-canvas/shared";
import type { Rect } from "./geometry";

/**
 * Where text goes and how it breaks into lines. Pure: the one thing it needs
 * from a browser, the width of a string, is passed in as `measure`, so the
 * rules are testable with a fake that counts characters.
 */

export const FONT_FAMILY = 'ui-rounded, "Segoe UI", system-ui, -apple-system, sans-serif';

/** Size of a closed shape's label, and of the text of a `text` shape, in CSS pixels. */
export const LABEL_FONT_SIZE = 15;
export const TEXT_FONT_SIZE = 20;
const LINE_HEIGHT = 1.3;

/** A `text` shape is never shorter than one line plus its padding. */
export const TEXT_PADDING = 6;
export const DEFAULT_TEXT_WIDTH = 200;
const MIN_TEXT_WIDTH = 40;

export type Measure = (text: string) => number;

export function fontSizeFor(kind: ShapeKind): number {
  return kind === "text" ? TEXT_FONT_SIZE : LABEL_FONT_SIZE;
}

export function lineHeightFor(kind: ShapeKind): number {
  return Math.round(fontSizeFor(kind) * LINE_HEIGHT);
}

/** The CSS `font` value used for a kind's text, by both the canvas and the editing box. */
export function fontFor(kind: ShapeKind): string {
  return `${kind === "text" ? 500 : 600} ${fontSizeFor(kind)}px ${FONT_FAMILY}`;
}

/**
 * Breaks `text` into lines no wider than `maxWidth`: at the line breaks the
 * person typed, then at spaces, and inside a word only when the word alone is
 * wider than a line. Always returns at least one line.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line !== "") lines.push(line);
      // A word that does not fit on a line of its own is broken between characters.
      let rest = word;
      let broke = false;
      while (rest !== "" && measure(rest) > maxWidth) {
        let cut = 1;
        while (cut < rest.length && measure(rest.slice(0, cut + 1)) <= maxWidth) cut += 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
        broke = true;
      }
      // If the word ended exactly on a break, its last piece stays open so the next word can join it.
      line = rest === "" && broke ? lines.pop()! : rest;
    }
    lines.push(line);
  }
  return lines;
}

/** Height of a `text` shape that is `width` wide and holds `text`. */
export function textShapeHeight(text: string, width: number, measure: Measure): number {
  const lines = wrapText(text, Math.max(1, width - TEXT_PADDING * 2), measure);
  return Math.round(lines.length * lineHeightFor("text") + TEXT_PADDING * 2);
}

/** Height of an empty `text` shape: one line. Also the height of a click-made text box. */
export function minTextHeight(): number {
  return Math.round(lineHeightFor("text") + TEXT_PADDING * 2);
}

export function clampTextWidth(width: number): number {
  return Math.max(MIN_TEXT_WIDTH, width);
}

/**
 * The part of a shape that its label may use. A rectangle can use nearly all
 * of it; the corners of an ellipse, diamond or triangle are empty, so their
 * label is confined to the middle. A line or arrow has no label.
 */
export function labelArea(kind: ShapeKind, rect: Rect): Rect | null {
  if (isLinearKind(kind)) return null;
  const inset = (fx: number, fy: number, fw: number, fh: number): Rect => ({
    x: rect.x + rect.width * fx,
    y: rect.y + rect.height * fy,
    width: rect.width * fw,
    height: rect.height * fh,
  });
  switch (kind) {
    case "ellipse":
      return inset(0.14, 0.14, 0.72, 0.72);
    case "diamond":
      return inset(0.25, 0.25, 0.5, 0.5);
    case "triangle":
      return inset(0.25, 0.42, 0.5, 0.5);
    case "text":
      return {
        x: rect.x + TEXT_PADDING,
        y: rect.y + TEXT_PADDING,
        width: rect.width - TEXT_PADDING * 2,
        height: rect.height - TEXT_PADDING * 2,
      };
    default:
      return inset(0.04, 0.04, 0.92, 0.92);
  }
}

/** Whether a kind's text is centred (a label) or starts at the left edge (a text shape). */
export function isCentered(kind: ShapeKind): boolean {
  return kind !== "text";
}

/** The lines of a label that fit in its area; the rest is cut off rather than spilling out of the shape. */
export function visibleLines(lines: readonly string[], areaHeight: number, lineHeight: number): string[] {
  const fit = Math.max(1, Math.floor(areaHeight / lineHeight));
  return lines.slice(0, fit);
}
