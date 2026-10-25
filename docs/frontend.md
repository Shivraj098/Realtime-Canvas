# Canvas UI

The browser app on top of the [client core](client.md). Source:
[`client/src/app`](../client/src/app) and [`client/src/main.ts`](../client/src/main.ts).
Plain TypeScript and the Canvas 2D API, built with Vite: no UI framework,
because the interesting state (the room) already lives in `SyncEngine`.

## How it is split

The rule is that **decisions are pure and testable; the browser glue is thin.**

| Module        | Kind     | Job                                                                                                 |
| ------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `geometry`    | pure     | Rectangles, hit-testing, resize maths (clamped, never flips), rounding to what the server accepts.  |
| `interaction` | pure     | The pointer state machine: press, drag, release become _effects_ (select, preview, create, update). |
| `scene`       | pure     | Engine state + the local gesture become "what to draw": drag overrides, remote previews, cursors.   |
| `render`      | pure-ish | Draws a scene to a 2D context. Takes a context, so it is tested with a recording fake.              |
| `smoothing`   | pure     | Makes remote cursors glide instead of jump (frame-rate independent).                                |
| `throttle`    | pure     | Leading + trailing throttle, so a drag always ends where the pointer stopped.                       |
| `canvas-view` | glue     | Canvas sizing, pointer events, the draw loop. Covered by the browser tests.                         |
| `ui`, `main`  | glue     | Toolbar, status, presence, keyboard shortcuts, room from the URL.                                   |

## One gesture, one op

Dragging a shape fires a pointer event dozens of times a second. If each
became an op, the log would fill with positions nobody needs. Instead:

1. **While dragging**, the position goes out as a `drag_preview` (about 30 per
   second, throttled). It is ephemeral: never stored, and other people draw the
   shape there with a dashed outline in the dragger's colour.
2. **On release**, ONE `update_shape` carries the final geometry (only the
   fields that changed). When its ack arrives, previews of that shape are dropped.

Drawing a rectangle works the same way: the outline is local while you drag, and
one `create_shape` is sent on release. A click without a drag makes a default
120×80 rectangle.

## Smooth remote cursors

Cursor updates arrive at the sender's throttle rate (about 30 Hz), so drawing
each where it was last reported would look jumpy. The drawn position chases the
reported one by a fixed _fraction of the remaining distance per unit time_
(half-life 45 ms). Because it is defined per unit time, not per frame, it looks
the same at 60 Hz and 144 Hz. A cursor seen for the first time appears in place
rather than flying in from the corner.

## Drawing on demand, sharp on any screen

- The canvas draws only when something changed (room, gesture, selection, size)
  and keeps requesting frames only while something is animating.
- Its backing store is `devicePixelRatio` times its CSS size, rescaled on resize
  (`ResizeObserver`) and when the window moves to a screen with a different density.
- Colours come from CSS variables, so the canvas follows light and dark mode.

## Rooms and sharing

The room is `?room=<id>`. Opening the app without one creates a room with a
random 128-bit id (22 URL-safe characters) and puts it in the address, so
"Copy link" shares it. With no authentication, **the id is the access control**:
anyone with the link can read and edit the room.

## Configuration

| Variable      | Where      | Meaning                                                                                                                                             |
| ------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_WS_URL` | build time | Address of the realtime server, e.g. `wss://canvas.example.com`. Without it the app uses the same host on port 8080, which suits local development. |

## Accessibility

Controls are real buttons with labels and pressed states, status changes are
announced (`aria-live`), and a visually hidden list mirrors every shape on the
board. The canvas itself cannot be read by a screen reader, so that list is the
accessible view of it. The same list is what the browser tests read.

## Testing

| Layer   | What                                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit    | Geometry, the interaction state machine, scene building, rendering calls, smoothing, throttling.                                                                                                                                         |
| Browser | Playwright drives two real Chromium browsers against the real server: drawing, moving with a live preview, resizing, recolouring, deleting, presence, cursors, two tabs, offline edits delivered on reconnect, sharpness on a 2x screen. |

Run them with `npm run e2e` (builds first). In CI they run as a separate
workflow so the fast checks are not held up by browsers.

## Known limits

- **No pan or zoom.** World coordinates are screen pixels, so people with
  different window sizes see the same coordinates in different places.
- **Rectangles only**, and stacking order is creation order (no "bring to front").
- **No undo.** Deleting is final (the shape stays as a tombstone in the log).
- **Touch** works through pointer events (and `touch-action: none`) but has only
  been exercised through the browser's pointer API, not on a physical device.
- Only Chromium is covered by the browser tests.
