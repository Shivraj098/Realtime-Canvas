import type { RoomClient, RoomClientEvent } from "../room-client";
import type { SocketStatus } from "../net/room-socket";
import type { RemotePreview } from "../sync/sync-engine";
import { labelFor } from "./scene";
import type { AppState } from "./state";

/** What the connection indicator says for each state of the socket. */
export const STATUS_TEXT: Record<SocketStatus, string> = {
  idle: "Starting…",
  connecting: "Connecting…",
  open: "Online",
  waiting: "Reconnecting…",
  closed: "Offline",
  unsupported_protocol: "Out of date: reload the page",
  refused: "This room link is not allowed",
};

/**
 * A short message for something the person should know about, or null when
 * nothing needs saying (most rejections just roll an edit back, which is
 * already visible). Kept as plain data so the wording is testable.
 */
export function noticeFor(event: RoomClientEvent): string | null {
  switch (event.type) {
    case "op_rejected":
      switch (event.reason) {
        case "rate_limited":
          return "You are making changes very fast. They will go through in a moment.";
        case "room_full":
          return "This board is full: no more shapes or changes can be added.";
        case "server_full":
          return "The server is full right now, so that change was not saved.";
        case "unknown_shape":
          return "Someone else removed that shape.";
        default:
          return null;
      }
    case "server_error":
      switch (event.code) {
        case "room_full":
          return "This room is full. Trying again shortly…";
        case "server_busy":
          return "The server is busy. Trying again shortly…";
        case "rate_limited":
          return "Too many messages: the connection was closed. Reconnecting…";
        case "invalid_room":
          return "This room link is not allowed.";
        default:
          return null;
      }
    case "resync_requested":
      return null;
  }
}

const NOTICE_VISIBLE_MS = 6000;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in the page`);
  return found as T;
}

/** "1 unsynced change", "3 unsynced changes", or nothing. */
export function pendingText(count: number): string {
  if (count === 0) return "";
  return `${count} unsynced ${count === 1 ? "change" : "changes"}`;
}

/** The geometry other people are currently previewing for a shape, merged, or null. */
function previewFor(shapeId: string, previews: readonly RemotePreview[]) {
  const merged: Record<string, number> = {};
  let found = false;
  for (const preview of previews) {
    if (preview.shapeId !== shapeId) continue;
    found = true;
    Object.assign(merged, preview.changes);
  }
  return found ? merged : null;
}

/**
 * Connects the buttons and indicators in the page to the room and the app
 * state. Everything that is plain text in the page (toolbar, status,
 * presence) is updated here; the canvas is drawn elsewhere.
 *
 * The shape list is a visually hidden list of every shape, kept in step with
 * the canvas. It exists so screen readers can reach what is drawn, and so
 * end-to-end tests can read the board without inspecting pixels.
 */
export function mountUi(client: RoomClient, state: AppState, onDelete: () => void): () => void {
  const toolButtons = {
    select: element<HTMLButtonElement>("tool-select"),
    rectangle: element<HTMLButtonElement>("tool-rectangle"),
  };
  const deleteButton = element<HTMLButtonElement>("delete");
  const swatches = [...document.querySelectorAll<HTMLButtonElement>(".swatch")];
  const statusBox = element("status");
  const statusText = element("status-text");
  const pending = element("pending");
  const presence = element<HTMLUListElement>("presence");
  const shapeList = element<HTMLUListElement>("shape-list");
  const copyButton = element<HTMLButtonElement>("copy-link");
  const notice = element("notice");

  const cleanups: (() => void)[] = [];
  const listen = <T extends EventTarget>(target: T, type: string, handler: EventListener): void => {
    target.addEventListener(type, handler);
    cleanups.push(() => target.removeEventListener(type, handler));
  };

  // ---- controls ----------------------------------------------------------

  listen(toolButtons.select, "click", () => state.setTool("select"));
  listen(toolButtons.rectangle, "click", () => state.setTool("rectangle"));
  listen(deleteButton, "click", onDelete);
  for (const swatch of swatches) {
    listen(swatch, "click", () => {
      const color = swatch.dataset.color;
      if (!color) return;
      state.setColor(color);
      const selected = state.getSelectedId();
      if (selected) client.updateShape(selected, { color });
    });
  }
  listen(copyButton, "click", () => {
    void navigator.clipboard
      .writeText(window.location.href)
      .then(() => "Link copied")
      .catch(() => "Copy the address bar")
      .then((message) => {
        copyButton.textContent = message;
        window.setTimeout(() => (copyButton.textContent = "Copy link"), 1600);
      });
  });

  // ---- rendering ---------------------------------------------------------

  let lastShapesSignature = "";
  let lastPresenceSignature = "";

  function renderControls(): void {
    const tool = state.getTool();
    for (const [name, button] of Object.entries(toolButtons)) {
      button.setAttribute("aria-pressed", String(name === tool));
    }
    for (const swatch of swatches)
      swatch.setAttribute("aria-pressed", String(swatch.dataset.color === state.getColor()));
    deleteButton.disabled = state.getSelectedId() === null;
  }

  function renderStatus(): void {
    const status = client.getStatus();
    statusBox.dataset.status = status;
    statusText.textContent = STATUS_TEXT[status];
    const count = client.engine.getPending().length;
    const text = pendingText(count);
    pending.textContent = text;
    pending.hidden = count === 0;
    pending.dataset.count = String(count);
  }

  function renderPresence(): void {
    const people = client.engine.getPresence();
    const signature = people.map((person) => `${person.clientId}:${person.color}`).join("|");
    if (signature === lastPresenceSignature) return;
    lastPresenceSignature = signature;
    presence.replaceChildren(
      ...people.map((person) => {
        const item = document.createElement("li");
        item.dataset.clientId = person.clientId;
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = person.color;
        const label = document.createElement("span");
        label.textContent = person.clientId === client.clientId ? "You" : labelFor(person.clientId);
        item.append(dot, label);
        return item;
      }),
    );
    presence.dataset.count = String(people.length);
  }

  function renderShapeList(): void {
    const shapes = client.engine.getLiveShapes();
    const previews = client.engine.getPreviews();
    const selectedId = state.getSelectedId();
    const entries = Object.entries(shapes);
    const signature = JSON.stringify([entries, previews, selectedId]);
    if (signature === lastShapesSignature) return;
    lastShapesSignature = signature;

    shapeList.replaceChildren(
      ...entries.map(([id, shape]) => {
        const item = document.createElement("li");
        item.dataset.shapeId = id;
        item.dataset.x = String(shape.x);
        item.dataset.y = String(shape.y);
        item.dataset.width = String(shape.width);
        item.dataset.height = String(shape.height);
        item.dataset.color = shape.color;
        if (id === selectedId) item.dataset.selected = "true";
        const preview = previewFor(id, previews);
        if (preview) {
          for (const [key, value] of Object.entries(preview))
            item.dataset[`preview${key[0]!.toUpperCase()}${key.slice(1)}`] = String(value);
        }
        item.textContent = `Rectangle, ${shape.color}, at ${shape.x}, ${shape.y}, ${shape.width} by ${shape.height}${preview ? ", being moved by someone else" : ""}`;
        return item;
      }),
    );
    shapeList.dataset.count = String(entries.length);
  }

  let scheduled = false;
  function render(): void {
    scheduled = false;
    renderControls();
    renderStatus();
    renderPresence();
    renderShapeList();
  }
  // Server messages can arrive faster than the screen refreshes (cursors especially); render at most once per frame.
  function scheduleRender(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  }

  // Notices: shown briefly, and replaced by the next one.
  let hideNotice: number | undefined;
  cleanups.push(
    client.onEvent((event) => {
      const text = noticeFor(event);
      if (!text) return;
      notice.textContent = text;
      notice.hidden = false;
      window.clearTimeout(hideNotice);
      hideNotice = window.setTimeout(() => (notice.hidden = true), NOTICE_VISIBLE_MS);
    }),
  );
  cleanups.push(() => window.clearTimeout(hideNotice));

  cleanups.push(client.subscribe(scheduleRender));
  cleanups.push(state.subscribe(scheduleRender));
  render();

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
