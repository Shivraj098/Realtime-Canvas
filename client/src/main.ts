import "./app/styles.css";
import { RoomClient } from "./room-client";
import { CanvasView } from "./app/canvas-view";
import { generateRoomId, roomIdFromSearch, serverUrl } from "./app/room-id";
import { AppState } from "./app/state";
import { deleteSelected, duplicateSelected } from "./app/actions";
import { isTypingTarget, toolForKey } from "./app/shortcuts";
import { mountUi } from "./app/ui";

/** Colours offered for new shapes. */
const PALETTE = ["#f28b82", "#fbbc59", "#6fcf97", "#6aa9f4", "#b39ddb"];
const DEFAULT_COLOR = PALETTE[3]!;

/** The room comes from `?room=`. Without one, make a private room and put it in the address so the link can be shared. */
function resolveRoom(): string {
  const existing = roomIdFromSearch(window.location.search);
  if (existing) return existing;
  const roomId = generateRoomId();
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.replaceState(null, "", url);
  return roomId;
}

function start(): void {
  const canvas = document.getElementById("board");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing #board in the page");

  const roomId = resolveRoom();
  // One client id per tab: two tabs are two participants, even for one person.
  const client = new RoomClient({ url: serverUrl(import.meta.env.VITE_WS_URL, window.location), roomId });
  const state = new AppState(DEFAULT_COLOR);
  const view = new CanvasView(canvas, client, state);

  const notify = (message: string): void => {
    const notice = document.getElementById("notice");
    if (!notice) return;
    notice.textContent = message;
    notice.hidden = false;
    window.setTimeout(() => (notice.hidden = true), 3000);
  };
  const exportImage = (): void => {
    void view.exportImage().then((saved) => {
      if (!saved) notify("Nothing to save yet: draw something first.");
    });
  };
  const duplicate = (): void => {
    if (!duplicateSelected(client, state)) notify("Select a shape to duplicate.");
  };
  mountUi(client, state, {
    onDelete: () => deleteSelected(client, state),
    onDuplicate: duplicate,
    onExport: exportImage,
  });

  window.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target as HTMLElement | null)) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "d") {
      event.preventDefault(); // the browser would bookmark the page
      duplicate();
      return;
    }
    if (modifier || event.altKey) return;
    const tool = toolForKey(event.key);
    if (tool) {
      state.setTool(tool);
      return;
    }
    switch (event.key) {
      case "Delete":
      case "Backspace":
        deleteSelected(client, state);
        event.preventDefault();
        break;
      case "Enter":
        view.editSelected();
        event.preventDefault();
        break;
      case "?": {
        const help = document.getElementById("help");
        if (help) help.hidden = !help.hidden;
        break;
      }
      case "Escape":
        view.cancelGesture();
        state.setSelectedId(null);
        state.setTool("select");
        document.getElementById("help")?.setAttribute("hidden", "");
        break;
    }
  });

  // When the network comes back, or the tab does, do not wait out the rest of a backoff.
  window.addEventListener("online", () => client.retryNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") client.retryNow();
  });

  client.connect();
}

start();
