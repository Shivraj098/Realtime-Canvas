import type { Tool } from "./interaction";

/** Inner markup of each 24x24 toolbar icon. Static strings, never built from user input. */
export const TOOL_ICONS: Record<Tool, string> = {
  select: '<path d="M5 3l14 8-6 1.5L10 19z" />',
  rect: '<rect x="4" y="6" width="16" height="12" rx="2.5" />',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" />',
  diamond: '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" />',
  triangle: '<path d="M12 4.5l8.5 15h-17z" />',
  line: '<path d="M5 19L19 5" />',
  arrow: '<path d="M5 19L19 5M10 5h9v9" />',
  text: '<path d="M6 6h12M12 6v13M9 19h6" />',
};
