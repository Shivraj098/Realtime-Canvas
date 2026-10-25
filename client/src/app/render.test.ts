import { describe, expect, it } from "vitest";
import { drawScene, type Theme } from "./render";
import type { Scene } from "./scene";

const theme: Theme = {
  background: "#bg",
  grid: "#grid",
  selection: "#sel",
  handleFill: "#hf",
  labelText: "#lt",
  shadow: "#shadow",
  font: "12px sans-serif",
};

type Call = { name: string; args: unknown[] };

/** A canvas context that records what it is asked to do and draws nothing. */
function recordingContext() {
  const calls: Call[] = [];
  const assigned: { name: string; value: unknown }[] = [];
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: text.length * 7 }),
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
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, assigned };
}

const view = { width: 400, height: 300, dpr: 2 };
const empty: Scene = { shapes: [], selectedRect: null, ghost: null, cursors: [] };

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
    const { ctx, calls, assigned } = recordingContext();
    drawScene(
      ctx,
      {
        ...empty,
        shapes: [
          { id: "a", rect: { x: 10, y: 10, width: 50, height: 40 }, color: "#aa0000", mode: "normal" },
          { id: "b", rect: { x: 80, y: 10, width: 50, height: 40 }, color: "#00bb00", mode: "normal" },
        ],
      },
      theme,
      view,
    );
    expect(fills(assigned)).toEqual(expect.arrayContaining(["#aa0000", "#00bb00"]));
    expect(names(calls).filter((n) => n === "stroke")).toHaveLength(2);
  });

  it("draws four resize handles and an outline only when something is selected", () => {
    const without = recordingContext();
    drawScene(without.ctx, empty, theme, view);
    expect(names(without.calls)).not.toContain("rect");

    const withSelection = recordingContext();
    drawScene(
      withSelection.ctx,
      { ...empty, selectedRect: { x: 10, y: 10, width: 50, height: 40 } },
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

  it("adds a shadow only for a shape being dragged by this user", () => {
    const dragging = recordingContext();
    drawScene(
      dragging.ctx,
      {
        ...empty,
        shapes: [
          { id: "a", rect: { x: 0, y: 0, width: 10, height: 10 }, color: "#aa0000", mode: "dragging" },
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
        shapes: [{ id: "a", rect: { x: 0, y: 0, width: 10, height: 10 }, color: "#aa0000", mode: "normal" }],
      },
      theme,
      view,
    );
    expect(normal.assigned.some((a) => a.name === "shadowBlur")).toBe(false);
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
      { ...empty, ghost: { rect: { x: 10, y: 10, width: 60, height: 40 }, color: "#abcdef" } },
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
          { id: "a", rect: { x: 0, y: 0, width: 10, height: 10 }, color: "#aa0000", mode: "dragging" },
          { id: "b", rect: { x: 20, y: 0, width: 10, height: 10 }, color: "#00aa00", mode: "remote-preview" },
        ],
        selectedRect: { x: 0, y: 0, width: 10, height: 10 },
        ghost: { rect: { x: 1, y: 1, width: 5, height: 5 }, color: "#abcdef" },
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
            { id: "z", rect: { x: 0, y: 0, width: 0, height: 0 }, color: "#aa0000", mode: "normal" },
            { id: "t", rect: { x: 0, y: 0, width: 3, height: 2 }, color: "#aa0000", mode: "normal" },
          ],
        },
        theme,
        view,
      ),
    ).not.toThrow();
  });
});
