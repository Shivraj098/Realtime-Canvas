import { describe, expect, it } from "vitest";
import { drawScene, type Theme } from "./render";
import type { DrawnShape, Scene } from "./scene";

const theme: Theme = {
  background: "#bg",
  grid: "#grid",
  selection: "#sel",
  handleFill: "#hf",
  labelText: "#lt",
  shadow: "#shadow",
  font: "12px sans-serif",
  shapeInk: "#ink",
  textShade: -0.4,
};

type Call = { name: string; args: unknown[] };

/** A canvas context that records what it is asked to do and draws nothing. */
function recordingContext() {
  const calls: Call[] = [];
  const assigned: { name: string; value: unknown }[] = [];
  const stops: string[] = [];
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: text.length * 7 }),
    // A closed shape is filled with a gradient from a lighter to its own colour; keep the colours asked for.
    createLinearGradient: () => ({ addColorStop: (_at: number, color: string) => stops.push(color) }),
  };
  const ctx = new Proxy(target, {
    get(obj, name: string) {
      if (name in obj) return obj[name];
      return (...args: unknown[]) => {
        calls.push({ name, args });
      };
    },
    set(obj, name: string, value) {
      assigned.push({ name, value });
      obj[name] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, assigned, stops };
}

const view = { width: 400, height: 300, dpr: 2 };
const empty: Scene = { shapes: [], selection: null, ghost: null, draft: null, cursors: [] };

const names = (calls: Call[]) => calls.map((c) => c.name);
const fills = (assigned: { name: string; value: unknown }[]) =>
  assigned.filter((a) => a.name === "fillStyle").map((a) => a.value);

describe("drawScene", () => {
  it("scales drawing by the device pixel ratio and clears the whole canvas first", () => {
    const { ctx, calls } = recordingContext();
    drawScene(ctx, empty, theme, view);
    expect(calls[0]).toEqual({ name: "setTransform", args: [2, 0, 0, 2, 0, 0] });
    expect(calls[1]).toEqual({ name: "clearRect", args: [0, 0, 400, 300] });
  });

  it("paints the background, then a grid of dots", () => {
    const { ctx, calls, assigned } = recordingContext();
    drawScene(ctx, empty, theme, view);
    expect(fills(assigned).slice(0, 2)).toEqual(["#bg", "#grid"]);
    expect(calls.filter((c) => c.name === "fillRect").length).toBeGreaterThan(100);
  });

  it("fills each shape in its own colour, and strokes it", () => {
    const { ctx, calls, stops } = recordingContext();
    drawScene(
      ctx,
      {
        ...empty,
        shapes: [
          {
            id: "a",
            kind: "rect",
            text: "",
            rect: { x: 10, y: 10, width: 50, height: 40 },
            color: "#aa0000",
            mode: "normal",
          },
          {
            id: "b",
            kind: "rect",
            text: "",
            rect: { x: 80, y: 10, width: 50, height: 40 },
            color: "#00bb00",
            mode: "normal",
          },
        ],
      },
      theme,
      view,
    );
    expect(stops).toEqual(expect.arrayContaining(["#aa0000", "#00bb00"]));
    expect(names(calls).filter((n) => n === "stroke")).toHaveLength(2);
  });

  it("draws four resize handles and an outline only when something is selected", () => {
    const without = recordingContext();
    drawScene(without.ctx, empty, theme, view);
    expect(names(without.calls)).not.toContain("rect");

    const withSelection = recordingContext();
    drawScene(
      withSelection.ctx,
      { ...empty, selection: { kind: "rect", rect: { x: 10, y: 10, width: 50, height: 40 } } },
      theme,
      view,
    );
    expect(names(withSelection.calls).filter((n) => n === "rect")).toHaveLength(4);
  });

  it("dashes the outline of a shape someone else is dragging, in their colour", () => {
    const { ctx, calls, assigned } = recordingContext();
    drawScene(
      ctx,
      {
        ...empty,
        shapes: [
          {
            id: "a",
            kind: "rect",
            text: "",
            rect: { x: 10, y: 10, width: 50, height: 40 },
            color: "#aa0000",
            mode: "remote-preview",
            ownerColor: "#0000ff",
          },
        ],
      },
      theme,
      view,
    );
    expect(calls.find((c) => c.name === "setLineDash")?.args).toEqual([[6, 4]]);
    expect(assigned.filter((a) => a.name === "strokeStyle").map((a) => a.value)).toContain("#0000ff");
  });

  it("lifts a shape higher while this user is dragging it", () => {
    const dragging = recordingContext();
    drawScene(
      dragging.ctx,
      {
        ...empty,
        shapes: [
          {
            id: "a",
            kind: "rect",
            text: "",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            color: "#aa0000",
            mode: "dragging",
          },
        ],
      },
      theme,
      view,
    );
    expect(dragging.assigned.some((a) => a.name === "shadowBlur" && a.value === 18)).toBe(true);

    const normal = recordingContext();
    drawScene(
      normal.ctx,
      {
        ...empty,
        shapes: [
          {
            id: "a",
            kind: "rect",
            text: "",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            color: "#aa0000",
            mode: "normal",
          },
        ],
      },
      theme,
      view,
    );
    expect(normal.assigned.some((a) => a.name === "shadowBlur" && a.value === 18)).toBe(false);
  });

  it("draws a name tag for each remote cursor", () => {
    const { ctx, calls } = recordingContext();
    drawScene(
      ctx,
      {
        ...empty,
        cursors: [
          { clientId: "a", x: 5, y: 5, color: "#f00", label: "ann" },
          { clientId: "b", x: 50, y: 50, color: "#0f0", label: "bob" },
        ],
      },
      theme,
      view,
    );
    expect(calls.filter((c) => c.name === "fillText").map((c) => c.args[0])).toEqual(["ann", "bob"]);
  });

  it("draws the outline of a rectangle being created", () => {
    const { ctx, calls } = recordingContext();
    drawScene(
      ctx,
      { ...empty, ghost: { kind: "rect", rect: { x: 10, y: 10, width: 60, height: 40 }, color: "#abcdef" } },
      theme,
      view,
    );
    expect(calls.some((c) => c.name === "setLineDash")).toBe(true);
  });

  it("leaves the drawing state balanced: every save has a restore", () => {
    const { ctx, calls } = recordingContext();
    drawScene(
      ctx,
      {
        shapes: [
          {
            id: "a",
            kind: "rect",
            text: "",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            color: "#aa0000",
            mode: "dragging",
          },
          {
            id: "b",
            kind: "rect",
            text: "",
            rect: { x: 20, y: 0, width: 10, height: 10 },
            color: "#00aa00",
            mode: "remote-preview",
          },
        ],
        selection: { kind: "rect", rect: { x: 0, y: 0, width: 10, height: 10 } },
        draft: null,
        ghost: { kind: "rect", rect: { x: 1, y: 1, width: 5, height: 5 }, color: "#abcdef" },
        cursors: [{ clientId: "c", x: 1, y: 1, color: "#f00", label: "c" }],
      },
      theme,
      view,
    );
    expect(names(calls).filter((n) => n === "save")).toHaveLength(
      names(calls).filter((n) => n === "restore").length,
    );
  });

  it("does not throw for a zero-size shape or a shape smaller than its corner radius", () => {
    const { ctx } = recordingContext();
    expect(() =>
      drawScene(
        ctx,
        {
          ...empty,
          shapes: [
            {
              id: "z",
              kind: "rect",
              text: "",
              rect: { x: 0, y: 0, width: 0, height: 0 },
              color: "#aa0000",
              mode: "normal",
            },
            {
              id: "t",
              kind: "rect",
              text: "",
              rect: { x: 0, y: 0, width: 3, height: 2 },
              color: "#aa0000",
              mode: "normal",
            },
          ],
        },
        theme,
        view,
      ),
    ).not.toThrow();
  });
});

describe("drawScene: every kind of shape", () => {
  const rect = { x: 20, y: 20, width: 120, height: 80 };
  const shapeOf = (kind: DrawnShape["kind"], extra: Partial<DrawnShape> = {}): DrawnShape => ({
    id: kind,
    kind,
    rect,
    color: "#336699",
    text: "",
    mode: "normal",
    ...extra,
  });
  const draw = (scene: Partial<Scene>) => {
    const recorded = recordingContext();
    drawScene(recorded.ctx, { ...empty, ...scene }, theme, view);
    return recorded;
  };
  const texts = (calls: Call[]) => calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);

  it.each(["rect", "ellipse", "diamond", "triangle", "line", "arrow", "text"] as const)(
    "draws a %s without throwing, with balanced save and restore",
    (kind) => {
      const { calls } = draw({ shapes: [shapeOf(kind, { text: "hi" })], selection: { kind, rect } });
      expect(names(calls).filter((n) => n === "save")).toHaveLength(
        names(calls).filter((n) => n === "restore").length,
      );
    },
  );

  it("traces an ellipse with ellipse(), and a diamond and a triangle as closed polygons", () => {
    expect(names(draw({ shapes: [shapeOf("ellipse")] }).calls)).toContain("ellipse");
    const diamond = draw({ shapes: [shapeOf("diamond")] }).calls;
    expect(diamond.filter((c) => c.name === "lineTo")).toHaveLength(3);
    const triangle = draw({ shapes: [shapeOf("triangle")] }).calls;
    expect(triangle.filter((c) => c.name === "lineTo")).toHaveLength(2);
  });

  it("draws an arrow as a stroke plus a filled head, and a line as the stroke alone", () => {
    const arrow = draw({ shapes: [shapeOf("arrow")] }).calls;
    const line = draw({ shapes: [shapeOf("line")] }).calls;
    expect(names(arrow).filter((n) => n === "fill")).toHaveLength(1);
    expect(names(line).filter((n) => n === "fill")).toHaveLength(0);
    expect(names(line).filter((n) => n === "stroke")).toHaveLength(1);
  });

  it("draws a line pointing up and left from its start to its end", () => {
    const { calls } = draw({
      shapes: [shapeOf("line", { rect: { x: 100, y: 100, width: -60, height: -40 } })],
    });
    expect(calls.find((c) => c.name === "moveTo")?.args).toEqual([100, 100]);
    expect(calls.find((c) => c.name === "lineTo")?.args).toEqual([40, 60]);
  });

  it("writes a label inside a closed shape, one call per wrapped line", () => {
    expect(texts(draw({ shapes: [shapeOf("rect", { text: "hello" })] }).calls)).toEqual(["hello"]);
    const wrapped = texts(draw({ shapes: [shapeOf("rect", { text: "one two three four five six" })] }).calls);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join(" ")).toBe("one two three four five six".slice(0, wrapped.join(" ").length));
  });

  it("writes nothing for an empty label, and nothing on a line or arrow", () => {
    expect(texts(draw({ shapes: [shapeOf("ellipse")] }).calls)).toEqual([]);
    expect(texts(draw({ shapes: [shapeOf("arrow", { text: "ignored" })] }).calls)).toEqual([]);
  });

  it("does not draw a shape's text while its text box is open", () => {
    expect(texts(draw({ shapes: [shapeOf("rect", { text: "typing", editing: true })] }).calls)).toEqual([]);
    expect(texts(draw({ shapes: [shapeOf("text", { text: "typing", editing: true })] }).calls)).toEqual([]);
  });

  it("cuts a label off at the lines that fit, instead of spilling out of the shape", () => {
    const small = shapeOf("rect", {
      rect: { x: 0, y: 0, width: 60, height: 30 },
      text: "a b c d e f g h i j k l",
    });
    expect(texts(draw({ shapes: [small] }).calls).length).toBeLessThanOrEqual(2);
  });

  it("shrinks and fades a shape that is popping in, and leaves a settled one alone", () => {
    const popping = draw({ shapes: [shapeOf("rect", { appear: 0.25 })] });
    expect(popping.calls.some((c) => c.name === "scale")).toBe(true);
    expect(popping.assigned.some((a) => a.name === "globalAlpha" && (a.value as number) < 1)).toBe(true);
    expect(draw({ shapes: [shapeOf("rect")] }).calls.some((c) => c.name === "scale")).toBe(false);
  });

  it("puts handles on the two ends of a selected line, and four corners on a selected box", () => {
    expect(names(draw({ selection: { kind: "arrow", rect } }).calls).filter((n) => n === "arc")).toHaveLength(
      2,
    );
    expect(
      names(draw({ selection: { kind: "ellipse", rect } }).calls).filter((n) => n === "rect"),
    ).toHaveLength(4);
  });

  it("outlines a text box that is open for a shape that does not exist yet", () => {
    const before = draw({}).calls.filter((c) => c.name === "setLineDash").length;
    expect(draw({ draft: rect }).calls.filter((c) => c.name === "setLineDash").length).toBeGreaterThan(
      before,
    );
  });
});
