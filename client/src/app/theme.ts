import type { Theme } from "./render";

const FALLBACK: Theme = {
  background: "#f6f5f1",
  grid: "#d9d6cc",
  selection: "#0f766e",
  handleFill: "#ffffff",
  labelText: "#ffffff",
  shadow: "rgba(0, 0, 0, 0.25)",
  font: "600 11px system-ui, sans-serif",
};

/** Reads the canvas colours from the page's CSS variables, so the canvas follows light and dark mode. */
export function readTheme(element: Element = document.documentElement): Theme {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--canvas-bg", FALLBACK.background),
    grid: read("--canvas-grid", FALLBACK.grid),
    selection: read("--accent", FALLBACK.selection),
    handleFill: read("--handle-fill", FALLBACK.handleFill),
    labelText: read("--label-text", FALLBACK.labelText),
    shadow: read("--canvas-shadow", FALLBACK.shadow),
    font: read("--canvas-font", FALLBACK.font),
  };
}
