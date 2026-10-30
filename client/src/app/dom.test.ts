// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomClient } from "../room-client";
import { AppState } from "./state";
import { TextEditor } from "./text-editor";
import { describeShape, mountUi } from "./ui";
import { ALL_TOOLS } from "./shortcuts";

/** The real page, so a button the code looks for but the HTML forgot is caught here and not in a browser. */
function loadPage(): void {
  const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.innerHTML = body;
}

function makeClient(): RoomClient {
  return new RoomClient({ url: "ws://localhost:1", roomId: "r" });
}

describe("the page and its controls", () => {
  beforeEach(loadPage);

  it("has every element the UI code looks for, so mounting does not throw", () => {
    const state = new AppState("#6aa9f4");
    const unmount = mountUi(makeClient(), state, {
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onExport: vi.fn(),
    });
    unmount();
  });

  it("builds one button per tool, and clicking one chooses it", async () => {
    const state = new AppState("#6aa9f4");
    const unmount = mountUi(makeClient(), state, {
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onExport: vi.fn(),
    });
    const buttons = document.querySelectorAll<HTMLButtonElement>("#tools button");
    expect(buttons).toHaveLength(ALL_TOOLS.length);
    document.getElementById("tool-ellipse")!.click();
    expect(state.getTool()).toBe("ellipse");
    await new Promise((resolve) => requestAnimationFrame(resolve)); // the UI redraws once per frame
    expect(document.getElementById("tool-ellipse")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("tool-select")!.getAttribute("aria-pressed")).toBe("false");
    unmount();
  });

  it("gives every tool a name a screen reader can use, and every colour swatch too", () => {
    mountUi(makeClient(), new AppState("#6aa9f4"), {
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onExport: vi.fn(),
    });
    for (const button of document.querySelectorAll("#tools button, .swatch")) {
      expect(button.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("starts with the duplicate and delete buttons disabled, and the export and help buttons wired", () => {
    const onExport = vi.fn();
    mountUi(makeClient(), new AppState("#6aa9f4"), { onDelete: vi.fn(), onDuplicate: vi.fn(), onExport });
    expect((document.getElementById("duplicate") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("delete") as HTMLButtonElement).disabled).toBe(true);
    document.getElementById("export")!.click();
    expect(onExport).toHaveBeenCalledOnce();
    const help = document.getElementById("help")!;
    expect(help.hidden).toBe(true);
    document.getElementById("help-button")!.click();
    expect(help.hidden).toBe(false);
    document.getElementById("help-close")!.click();
    expect(help.hidden).toBe(true);
  });

  it("describes a shape by kind, label and place for a screen reader", () => {
    const shape = { x: 1, y: 2, width: 3, height: 4, color: "#fff", text: "Start" };
    expect(describeShape("ellipse", shape, false)).toBe('Ellipse, saying "Start", #fff, at 1, 2, 3 by 4');
    expect(describeShape("arrow", { ...shape, text: "" }, true)).toContain("being moved by someone else");
  });
});

describe("TextEditor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const target = {
    kind: "rect" as const,
    rect: { x: 10, y: 20, width: 200, height: 80 },
    text: "old",
    ink: "#123456",
  };
  const box = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>(".text-editor")!;
  const press = (key: string, shiftKey = false): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    box().dispatchEvent(event);
    return event;
  };

  it("opens over the shape's label area with the current text, in the shape's ink", () => {
    const editor = new TextEditor(document.body);
    editor.open(target, vi.fn());
    expect(editor.isOpen()).toBe(true);
    expect(box().hidden).toBe(false);
    expect(box().value).toBe("old");
    expect(box().style.color).not.toBe("");
    expect(box().maxLength).toBe(500);
  });

  it("Enter finishes with the typed text, and reports exactly once even though hiding the box blurs it", () => {
    const done = vi.fn();
    const editor = new TextEditor(document.body);
    editor.open(target, done);
    box().value = "new text  \n";
    press("Enter");
    box().dispatchEvent(new Event("blur"));
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith("new text"); // trailing whitespace removed
    expect(box().hidden).toBe(true);
    expect(editor.isOpen()).toBe(false);
  });

  it("Shift+Enter is a new line, not the end of typing", () => {
    const done = vi.fn();
    new TextEditor(document.body).open(target, done);
    const event = press("Enter", true);
    expect(event.defaultPrevented).toBe(false);
    expect(done).not.toHaveBeenCalled();
  });

  it("Escape throws the typing away", () => {
    const done = vi.fn();
    new TextEditor(document.body).open(target, done);
    box().value = "typed then regretted";
    press("Escape");
    expect(done).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("clicking elsewhere (blur) finishes with what was typed", () => {
    const done = vi.fn();
    new TextEditor(document.body).open(target, done);
    box().value = "kept";
    box().dispatchEvent(new Event("blur"));
    expect(done).toHaveBeenCalledExactlyOnceWith("kept");
  });

  it("opening over an open box finishes the first, so no typing is lost", () => {
    const first = vi.fn();
    const second = vi.fn();
    const editor = new TextEditor(document.body);
    editor.open(target, first);
    box().value = "first answer";
    editor.open({ ...target, text: "other" }, second);
    expect(first).toHaveBeenCalledExactlyOnceWith("first answer");
    expect(box().value).toBe("other");
  });

  it("discard closes the box and reports nothing", () => {
    const done = vi.fn();
    const editor = new TextEditor(document.body);
    editor.open(target, done);
    editor.discard();
    expect(done).not.toHaveBeenCalled();
    expect(editor.isOpen()).toBe(false);
  });

  it("keeps its key presses to itself, so typing never triggers a page shortcut", () => {
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    new TextEditor(document.body).open(target, vi.fn());
    press("r");
    press("Backspace");
    window.removeEventListener("keydown", seen);
    expect(seen).not.toHaveBeenCalled();
  });
});
