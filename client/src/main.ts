import "./app/styles.css";
import { RoomClient } from "./room-client";
import { CanvasView } from "./app/canvas-view";
import { generateRoomId, roomIdFromSearch, serverUrl } from "./app/room-id";
import { AppState } from "./app/state";
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

  const deleteSelected = (): void => {
    const selected = state.getSelectedId();
    if (!selected) return;
    client.deleteShape(selected);
    state.setSelectedId(null);
  };
  mountUi(client, state, deleteSelected);

  window.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case "v":
        state.setTool("select");
        break;
      case "r":
        state.setTool("rectangle");
        break;
      case "Delete":
      case "Backspace":
        deleteSelected();
        event.preventDefault();
        break;
      case "Escape":
        view.cancelGesture();
        state.setSelectedId(null);
        state.setTool("select");
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
