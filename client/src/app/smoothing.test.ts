import { describe, expect, it } from "vitest";
import { approach, CursorSmoother } from "./smoothing";

const cursor = (clientId: string, x: number, y: number) => ({ clientId, x, y, color: "#fff" });

describe("approach", () => {
  it("covers half the distance in one half-life", () => {
    expect(approach(0, 100, 50, 50)).toBeCloseTo(50);
  });

  it("is independent of how the elapsed time is split into frames", () => {
    const oneStep = approach(0, 100, 32, 45);
    const twoSteps = approach(approach(0, 100, 16, 45), 100, 16, 45);
    expect(twoSteps).toBeCloseTo(oneStep, 10);
  });

  it("does not move when no time has passed", () => {
    expect(approach(10, 100, 0, 45)).toBe(10);
  });

  it("jumps straight to the target when the half-life is zero", () => {
    expect(approach(10, 100, 16, 0)).toBe(100);
  });

  it("works downward too", () => {
    expect(approach(100, 0, 50, 50)).toBeCloseTo(50);
  });
});

describe("CursorSmoother", () => {
  it("shows a new cursor where it is, not flying in from the origin", () => {
    const smoother = new CursorSmoother(45);
    expect(smoother.step([cursor("a", 300, 200)], 16)).toEqual([cursor("a", 300, 200)]);
  });

  it("moves an existing cursor part of the way toward its new target", () => {
    const smoother = new CursorSmoother(45);
    smoother.step([cursor("a", 0, 0)], 16);
    const [moved] = smoother.step([cursor("a", 100, 0)], 45);
    expect(moved!.x).toBeCloseTo(50);
  });

  it("converges on the target and then reports it is done", () => {
    const smoother = new CursorSmoother(45);
    smoother.step([cursor("a", 0, 0)], 16);
    const target = [cursor("a", 100, 40)];
    expect(smoother.isAnimating(target)).toBe(true);
    for (let i = 0; i < 100; i++) smoother.step(target, 16);
    expect(smoother.step(target, 16)).toEqual(target);
    expect(smoother.isAnimating(target)).toBe(false);
  });

  it("forgets cursors that are gone, so a returning one appears in place", () => {
    const smoother = new CursorSmoother(45);
    smoother.step([cursor("a", 0, 0)], 16);
    smoother.step([], 16);
    expect(smoother.step([cursor("a", 500, 500)], 16)).toEqual([cursor("a", 500, 500)]);
  });

  it("tracks each cursor independently", () => {
    const smoother = new CursorSmoother(45);
    smoother.step([cursor("a", 0, 0), cursor("b", 100, 100)], 16);
    const result = smoother.step([cursor("a", 100, 0), cursor("b", 100, 100)], 45);
    expect(result[0]!.x).toBeCloseTo(50);
    expect(result[1]).toEqual(cursor("b", 100, 100));
  });
});
