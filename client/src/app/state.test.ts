import { describe, expect, it, vi } from "vitest";
import { AppState } from "./state";

describe("AppState", () => {
  it("starts on the select tool with nothing selected", () => {
    const state = new AppState("#123456");
    expect(state.getTool()).toBe("select");
    expect(state.getSelectedId()).toBeNull();
    expect(state.getColor()).toBe("#123456");
  });

  it("changes and reports each setting", () => {
    const state = new AppState("#123456");
    state.setTool("rectangle");
    state.setColor("#abcdef");
    state.setSelectedId("s1");
    expect([state.getTool(), state.getColor(), state.getSelectedId()]).toEqual([
      "rectangle",
      "#abcdef",
      "s1",
    ]);
  });

  it("notifies on a real change but not on setting the same value again", () => {
    const state = new AppState("#123456");
    const listener = vi.fn();
    state.subscribe(listener);
    state.setTool("rectangle");
    state.setTool("rectangle");
    state.setColor("#123456");
    state.setSelectedId(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const state = new AppState("#123456");
    const listener = vi.fn();
    const unsubscribe = state.subscribe(listener);
    unsubscribe();
    state.setTool("rectangle");
    expect(listener).not.toHaveBeenCalled();
  });
});
