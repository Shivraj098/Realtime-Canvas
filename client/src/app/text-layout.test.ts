import { describe, expect, it } from "vitest";
import {
  clampTextWidth,
  fontFor,
  isCentered,
  labelArea,
  lineHeightFor,
  minTextHeight,
  textShapeHeight,
  TEXT_PADDING,
  visibleLines,
  wrapText,
} from "./text-layout";

/** Every character is 10 pixels wide, so line widths are easy to reason about. */
const measure = (text: string): number => text.length * 10;

describe("wrapText", () => {
  it("keeps a short line whole", () => {
    expect(wrapText("hello world", 200, measure)).toEqual(["hello world"]);
  });

  it("breaks at spaces when the line is too wide", () => {
    expect(wrapText("one two three four", 90, measure)).toEqual(["one two", "three", "four"]);
  });

  it("keeps the line breaks the person typed, including blank lines", () => {
    expect(wrapText("a\n\nb", 200, measure)).toEqual(["a", "", "b"]);
    expect(wrapText("a\r\nb", 200, measure)).toEqual(["a", "b"]);
  });

  it("breaks inside a word that is wider than a line, and loses no characters", () => {
    const lines = wrapText("abcdefghijkl", 50, measure);
    expect(lines).toEqual(["abcde", "fghij", "kl"]);
    expect(lines.join("")).toBe("abcdefghijkl");
  });

  it("starts a long word on a fresh line, after the words before it", () => {
    expect(wrapText("hi abcdefghij", 50, measure)).toEqual(["hi", "abcde", "fghij"]);
  });

  it("always returns at least one line, and always makes progress on a width narrower than a character", () => {
    expect(wrapText("", 100, measure)).toEqual([""]);
    expect(wrapText("abc", 1, measure)).toEqual(["a", "b", "c"]);
  });

  it("never loses text, whatever the width", () => {
    const text = "the quick brown fox  jumps\nover   the lazy dog";
    for (const width of [10, 35, 80, 300]) {
      expect(wrapText(text, width, measure).join(" ").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    }
  });
});

describe("text shape size", () => {
  it("is one line plus padding for short text, and grows by a line height per wrapped line", () => {
    const one = textShapeHeight("hi", 200, measure);
    expect(one).toBe(minTextHeight());
    const two = textShapeHeight("a\nb", 200, measure);
    expect(two - one).toBe(lineHeightFor("text"));
  });

  it("wraps at the width minus the padding", () => {
    const inner = 100 - TEXT_PADDING * 2;
    const fits = "x".repeat(Math.floor(inner / 10));
    expect(textShapeHeight(fits, 100, measure)).toBe(minTextHeight());
    expect(textShapeHeight(`${fits}x`, 100, measure)).toBeGreaterThan(minTextHeight());
  });

  it("clamps a dragged width to a usable minimum", () => {
    expect(clampTextWidth(5)).toBe(40);
    expect(clampTextWidth(300)).toBe(300);
  });
});

describe("labelArea", () => {
  const rect = { x: 0, y: 0, width: 200, height: 100 };

  it("is inside the shape for every closed kind, and smaller for the pointed ones", () => {
    for (const kind of ["rect", "ellipse", "diamond", "triangle", "text"] as const) {
      const area = labelArea(kind, rect)!;
      expect(area.x).toBeGreaterThanOrEqual(0);
      expect(area.y).toBeGreaterThanOrEqual(0);
      expect(area.x + area.width).toBeLessThanOrEqual(200);
      expect(area.y + area.height).toBeLessThanOrEqual(100);
    }
    expect(labelArea("diamond", rect)!.width).toBeLessThan(labelArea("rect", rect)!.width);
    expect(labelArea("triangle", rect)!.y).toBeGreaterThan(labelArea("rect", rect)!.y);
  });

  it("is nothing for a line or arrow", () => {
    expect(labelArea("line", rect)).toBeNull();
    expect(labelArea("arrow", rect)).toBeNull();
  });
});

describe("small helpers", () => {
  it("labels are centred and text shapes are not", () => {
    expect(isCentered("ellipse")).toBe(true);
    expect(isCentered("text")).toBe(false);
  });

  it("shows only the lines that fit, but at least one", () => {
    expect(visibleLines(["a", "b", "c", "d"], 45, 20)).toEqual(["a", "b"]);
    expect(visibleLines(["a", "b"], 5, 20)).toEqual(["a"]);
  });

  it("uses a larger font for text shapes", () => {
    expect(fontFor("text")).toContain("20px");
    expect(fontFor("rect")).toContain("15px");
  });
});
