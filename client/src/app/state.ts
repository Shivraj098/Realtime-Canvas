import type { Rect } from "./geometry";
import type { Tool } from "./interaction";

/** What the text box is open over: an existing shape, or a text shape that will exist once the typing is done. */
export type Editing = { kind: "shape"; shapeId: string } | { kind: "draft"; rect: Rect };

/**
 * The few things about the UI that are not part of the room: which tool is
 * active, which colour new shapes get, and which shape is selected. Kept
 * apart from the room state because they are local to this tab and never
 * sent anywhere.
 */
export class AppState {
  private tool: Tool = "select";
  private selectedId: string | null = null;
  private editing: Editing | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private color: string) {}

  getTool(): Tool {
    return this.tool;
  }

  getColor(): string {
    return this.color;
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  getEditing(): Editing | null {
    return this.editing;
  }

  setEditing(editing: Editing | null): void {
    this.update(() => {
      if (this.editing === null && editing === null) return false;
      this.editing = editing;
      return true;
    });
  }

  setTool(tool: Tool): void {
    this.update(() => {
      if (this.tool === tool) return false;
      this.tool = tool;
      return true;
    });
  }

  setColor(color: string): void {
    this.update(() => {
      if (this.color === color) return false;
      this.color = color;
      return true;
    });
  }

  setSelectedId(shapeId: string | null): void {
    this.update(() => {
      if (this.selectedId === shapeId) return false;
      this.selectedId = shapeId;
      return true;
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(change: () => boolean): void {
    if (!change()) return;
    for (const listener of [...this.listeners]) listener();
  }
}
