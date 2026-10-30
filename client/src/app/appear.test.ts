import { describe, expect, it } from "vitest";
import { APPEAR_DURATION_MS, AppearTracker } from "./appear";

describe("AppearTracker", () => {
  it("animates nothing until the board has loaded", () => {
    const tracker = new AppearTracker();
    expect(tracker.update(["a", "b"], 0, false).size).toBe(0);
    expect(tracker.isAnimating()).toBe(false);
  });

  it("does not animate the shapes that were there when the board loaded", () => {
    const tracker = new AppearTracker();
    expect(tracker.update(["a", "b"], 0, true).size).toBe(0);
    expect(tracker.update(["a", "b"], 100, true).size).toBe(0);
    expect(tracker.isAnimating()).toBe(false);
  });

  it("animates a shape that appears afterwards, from 0 to 1, then stops", () => {
    const tracker = new AppearTracker();
    tracker.update(["a"], 0, true);
    expect(tracker.update(["a", "b"], 1000, true).get("b")).toBe(0);
    expect(tracker.isAnimating()).toBe(true);
    expect(tracker.update(["a", "b"], 1000 + APPEAR_DURATION_MS / 2, true).get("b")).toBeCloseTo(0.5);
    expect(tracker.update(["a", "b"], 1000 + APPEAR_DURATION_MS, true).has("b")).toBe(false);
    expect(tracker.isAnimating()).toBe(false);
  });

  it("animates a shape once: it does not pop in again after it settles", () => {
    const tracker = new AppearTracker();
    tracker.update([], 0, true);
    tracker.update(["a"], 10, true);
    tracker.update(["a"], 10 + APPEAR_DURATION_MS + 1, true);
    expect(tracker.update(["a"], 10 + APPEAR_DURATION_MS + 50, true).size).toBe(0);
  });

  it("drops a shape that is deleted mid-animation", () => {
    const tracker = new AppearTracker();
    tracker.update([], 0, true);
    tracker.update(["a"], 10, true);
    expect(tracker.update([], 20, true).size).toBe(0);
    expect(tracker.isAnimating()).toBe(false);
  });

  it("treats the first frame after loading as the baseline even if the board is empty", () => {
    const tracker = new AppearTracker();
    tracker.update([], 0, true);
    expect(tracker.update(["new"], 5, true).has("new")).toBe(true);
  });
});
