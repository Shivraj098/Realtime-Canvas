import { MAX_TEXT_LENGTH, type ShapeKind } from "@realtime-canvas/shared";
import type { Rect } from "./geometry";
import { fontFor, isCentered, labelArea, lineHeightFor } from "./text-layout";

/**
 * The box you type into. A real <textarea> laid over the canvas, because that
 * is the one thing the browser does well: caret, selection, IME composition,
 * copy and paste, mobile keyboards. The canvas keeps drawing everything else.
 *
 * Enter finishes (Shift+Enter adds a line), Escape throws the typing away,
 * and clicking elsewhere finishes. The result is reported exactly once.
 */

export type TextEditorOpen = {
  kind: ShapeKind;
  /** The shape's box (or the box a new text shape will have). */
  rect: Rect;
  text: string;
  /** Colour the typed text should have. */
  ink: string;
};

/** The finished text, or null if the person pressed Escape. */
export type TextEditorDone = (text: string | null) => void;

export class TextEditor {
  private readonly box: HTMLTextAreaElement;
  private done: TextEditorDone | null = null;

  constructor(parent: HTMLElement) {
    const box = document.createElement("textarea");
    box.className = "text-editor";
    box.hidden = true;
    box.rows = 1;
    box.maxLength = MAX_TEXT_LENGTH;
    box.spellcheck = false;
    box.setAttribute("aria-label", "Shape text");
    parent.append(box);
    this.box = box;

    box.addEventListener("keydown", (event) => {
      event.stopPropagation(); // typing is not a shortcut
      if (event.key === "Escape") {
        event.preventDefault();
        this.finish(null);
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.finish(box.value);
      }
    });
    box.addEventListener("blur", () => this.finish(box.value));
  }

  isOpen(): boolean {
    return this.done !== null;
  }

  open(target: TextEditorOpen, done: TextEditorDone): void {
    // Opening over an open box finishes the first one, so no typing is lost.
    this.finish(this.box.value);

    const area = labelArea(target.kind, target.rect) ?? target.rect;
    const style = this.box.style;
    style.left = `${area.x}px`;
    style.top = `${area.y}px`;
    style.width = `${Math.max(48, area.width)}px`;
    style.height = `${Math.max(lineHeightFor(target.kind), area.height)}px`;
    style.font = fontFor(target.kind);
    style.lineHeight = `${lineHeightFor(target.kind)}px`;
    style.textAlign = isCentered(target.kind) ? "center" : "left";
    style.color = target.ink;

    this.box.value = target.text;
    this.box.hidden = false;
    this.done = done;
    this.box.focus();
    this.box.setSelectionRange(this.box.value.length, this.box.value.length);
  }

  /** Closes the box without reporting anything. */
  discard(): void {
    this.finish(null, false);
  }

  private finish(text: string | null, report = true): void {
    const done = this.done;
    if (done === null) return;
    this.done = null;
    this.box.hidden = true;
    const cleaned = text === null ? null : text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    if (report) done(cleaned);
  }
}
