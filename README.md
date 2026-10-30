# realtime-canvas

A real-time collaborative whiteboard. Open a link, draw, and everyone else on
that link sees your shapes, text and cursor move as you work. No accounts, no
install.

**Live demo:** _add the link here once it is deployed_

> The demo runs on a free server that sleeps when idle and has no persistent
> disk. The first connection after a quiet spell can take a few seconds, and
> boards reset when the server restarts. Run it on any host with a disk
> mounted at `/data` and boards survive restarts.

The whiteboard is the excuse. What I wanted to build is the part of a
real-time app that tutorials skip: **what happens when two people edit the
same thing at the same moment, over a network that drops, lags and reorders?**

## What it does

- **Seven kinds of shape:** rectangle, ellipse, diamond, triangle, line,
  arrow and free text.
- **Text everywhere:** double-click a shape to label it, double-click empty
  canvas to write. Typing is a real `<textarea>` laid over the canvas, so
  selection, paste and IME input come from the browser rather than from me.
- **Move, resize, recolour, duplicate, delete.** Lines and arrows have a
  handle on each end and can point in any direction. Shift constrains:
  square boxes, 45° lines, single-axis drags.
- **Live cursors and drag previews.** You see other people's cursors glide
  and their shapes move _while_ they drag, not only after they let go.
- **Survives bad networks.** Close the laptop, lose Wi-Fi, switch to mobile
  data: the page reconnects by itself, catches up on only what it missed, and
  nothing you drew while offline is lost or applied twice.
- **Save as PNG, keyboard shortcuts (`?` lists them), light and dark mode,
  screen-reader labels** on every shape and control.

Share the URL (it carries `?room=...`) and anyone who has it is in the same
room. A new visit gets a new random room.

## How it works

The interesting decisions, briefly. Each links to a longer write-up in
[`docs/`](docs).

### The server decides the order

Wall-clock timestamps are wrong in this situation: two laptops disagree about
the time, and "last write wins" then means "whoever's clock is fast wins". So
every operation is stamped by the **server** with a
[Hybrid Logical Clock](shared/src/hlc.ts) (physical time plus a counter plus a
node id, which gives a total order that never goes backwards) and given a
per-room sequence number. A client's own timestamp is only ever used to nudge
the server's clock, and only if it is within a minute of real time, so a
laptop with a broken clock cannot poison the ordering.

### Conflicts are resolved per field

A shape is a handful of independent fields: `x`, `y`, `width`, `height`,
`color`, `text`. Each is its own last-writer-wins register
([`reconcile.ts`](shared/src/reconcile.ts)). If I recolour a shape while you
drag it, both changes survive, because they touch different fields. If we
both recolour it, the later one wins, and every client and the server agree
which that is. Deleting leaves a tombstone, so a replayed old `create` can't
bring a shape back.

The same `applyOp` function runs on the client and the server. It lives in
`shared/` precisely so "how conflicts resolve" can't drift between them.

### An append-only log, and cheap reconnects

Every accepted operation goes into a SQLite log (WAL mode) with a sequence
number per room, and a `UNIQUE(room_id, op_id)` constraint that makes every
operation **idempotent**: a client that retries an op it never saw an
acknowledgement for cannot apply it twice. A reconnecting client sends the
last sequence number it saw and receives only the operations after it. Join
fresh, or claim a sequence number the server has never reached, and you get a
full snapshot instead. Rooms are rebuilt from a periodic snapshot plus the
tail of the log, so a big room doesn't mean replaying its whole history.

### The client never has to roll back

The client keeps two things: the state the server has confirmed, and a queue
of my operations the server hasn't acknowledged yet. What you see is the
confirmed state with the queue applied on top. If the server rejects an
operation, I drop it from the queue and the view corrects itself; there is
nothing to undo. One drag is **one** operation however long it lasts, which
keeps the log small; the in-between movement travels as ephemeral previews
that are never stored.

### Two kinds of traffic

Durable operations (create, update, delete) are validated, stamped, stored
and acknowledged. Ephemeral messages (cursors, drag previews) are relayed and
forgotten. They have separate rate limits so a busy cursor can't starve a
real edit.

### A server that stays up

There are no accounts, so the room id (128 random bits) is the access
control, and the server assumes anyone can talk to it. Every inbound frame is
validated with zod; one malformed frame costs the sender a "strike" but never
crashes the process. There are token-bucket rate limits, caps on connections,
rooms, shapes and log size, a heartbeat that drops dead connections, idle-room
eviction, an `Origin` allowlist, and a `/health` endpoint. On `SIGTERM` it
saves snapshots and exits cleanly. Details and defaults:
[`docs/hardening.md`](docs/hardening.md).

## Getting started

You need **Node 22.12 or newer**.

```bash
git clone https://github.com/Shivraj098/Realtime-Canvas.git
cd Realtime-Canvas
npm ci
```

Run the server and the client in two terminals:

```bash
npm run dev -w server    # WebSocket server on ws://localhost:8080
npm run dev -w client    # web app on http://localhost:5173
```

Open http://localhost:5173 in two browser windows, copy the URL from one into
the other, and draw. The local database is created at `server/data/ops.sqlite`
(git-ignored); delete it to reset every board.

The client looks for the server on the same host at port 8080. To point it
elsewhere, set `VITE_WS_URL` (for example `wss://example.com`) when building.

### Shortcuts

| Key                    | Does                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `V`                    | Select and move                                                                  |
| `R` `O` `D` `G`        | Rectangle, ellipse, diamond, triangle                                            |
| `L` `A`                | Line, arrow                                                                      |
| `T`                    | Text (or double-click empty canvas)                                              |
| Double-click / `Enter` | Edit a shape's text. `Enter` finishes, `Shift+Enter` adds a line, `Esc` discards |
| `Shift`                | While drawing: square, circle, 45° lines. While dragging: one axis               |
| `Ctrl/Cmd + D`         | Duplicate                                                                        |
| `Delete`               | Remove the selected shape                                                        |
| `?`                    | Show this list in the app                                                        |
| `Esc`                  | Cancel the current gesture, or deselect                                          |

## Project layout

An npm-workspaces monorepo, all TypeScript in strict mode.

```
shared/   Hybrid Logical Clock, wire protocol types, and applyOp (conflict
          resolution). Imported by both sides; no runtime dependencies.
server/   WebSocket server (ws), zod validation, rooms and presence, SQLite
          op log (better-sqlite3), limits, health check, graceful shutdown.
client/   Vite web app. net/ is the self-healing socket, sync/ is the pure
          state machine, app/ is the canvas, interaction, rendering and UI.
docs/     Protocol, client internals, canvas UI, hardening, deployment.
```

The client and server resolve `@realtime-canvas/shared` straight from its
TypeScript source, so you never need to build `shared` before running or
testing anything else.

## Scripts

Run from the repo root; each command runs across all three workspaces.

| Command                | Does                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `npm run lint`         | ESLint                                                                                |
| `npm run format:check` | Prettier (use `npm run format` to fix)                                                |
| `npm run typecheck`    | `tsc` in every workspace                                                              |
| `npm run test`         | Unit and integration tests (Vitest)                                                   |
| `npm run build`        | Builds everything. The server build ends with a smoke test of the bundle it just made |
| `npm run e2e`          | Browser tests (Playwright); see below                                                 |

CI runs lint, format, typecheck, tests and build on every push, builds the
Docker image and checks that the container starts, answers `/health` and
exits cleanly on `SIGTERM`, and runs the browser tests in a separate job.

## Testing

Well over 800 tests, and I tried to make them test behaviour rather than
lines.

- **Conflict resolution** is tested directly: concurrent edits to the same
  and to different fields, duplicates, replays, out-of-order delivery, deletes.
- **The server is tested over real sockets with real SQLite**, not mocks:
  reconnect and replay, idempotent retries, hostile and malformed frames,
  rate limits, caps, origin checks, restart persistence, and upgrading
  databases written by older versions.
- **A property-based test** (fast-check) throws random sequences of creates,
  moves, recolours, relabels and deletes from several clients, with
  disconnects and reconnects in between, and asserts that **every client ends
  with exactly the state a fresh joiner receives**.
- **Pure logic is kept out of the DOM** so it can be tested without a
  browser: hit-testing for each shape, the pointer state machine, text
  wrapping, scene building, rendering against a recording canvas.
- **Browser tests** drive two real browsers against the real server: shapes
  and text appearing on both, live drags, going offline and coming back,
  late joiners seeing what was already drawn, a full board.

I also checked that the important safeguards matter by deliberately removing
them one at a time (the duplicate check, the clock-drift guard, the identity
override, the validation gate) and confirming a test fails each time.

To run the browser tests once:

```bash
npx playwright install chromium
npm run e2e
```

## Configuration

The server is configured with environment variables. Nothing is secret; none
are required for local development.

| Variable               | Default             | Meaning                                                                                                                              |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                 | `8080`              | Port to listen on                                                                                                                    |
| `DB_PATH`              | `./data/ops.sqlite` | SQLite file; `:memory:` for a throwaway database                                                                                     |
| `ALLOWED_ORIGINS`      | none                | Comma-separated web origins allowed to connect. **Required when `NODE_ENV=production`**; `ALLOW_ANY_ORIGIN=true` opts out on purpose |
| `MIN_ROOM_ID_LENGTH`   | `1`                 | Refuse shorter room ids. I run `16`, so guessable names like `demo` are refused                                                      |
| `MAX_CONNECTIONS`      | `500`               | Simultaneous connections                                                                                                             |
| `MAX_CLIENTS_PER_ROOM` | `50`                | People in one room                                                                                                                   |
| `MAX_SHAPES_PER_ROOM`  | `2000`              | Shapes per room (deleted ones count)                                                                                                 |
| `OPS_PER_SECOND`       | `20`                | Sustained edits per second per connection (bursts of 40)                                                                             |

There are more limits (rooms, log size, payload size, heartbeat, idle
eviction) with their defaults in [`docs/hardening.md`](docs/hardening.md).

## Deploying

The web app is static files, so it goes on Vercel. The server needs a
long-lived process that can hold WebSockets open, so it ships as a Docker
image (`Dockerfile`): a three-stage build that runs the smoke test, then a
small runtime image running as an unprivileged user. I run it on a free
Koyeb instance. Step-by-step instructions, the settings, and what the free
tier does and doesn't give you are in
[`docs/deployment.md`](docs/deployment.md).

Because room state is cached in the server process and the log is a local
file, **run exactly one server instance.**

## Limitations

Things I know about and chose not to build:

- **One server instance.** Scaling out would need a shared log and
  cross-process message fan-out (Postgres plus pub/sub, say). That is a
  different design.
- **No accounts.** Anyone with a room link can edit that room. The `Origin`
  allowlist stops other _websites_ using a visitor's browser against the
  server; it isn't authentication.
- **No pan, zoom or undo**, and stacking order is creation order (no "bring
  to front"). The canvas is a fixed plane.
- **Text is plain.** One size, no formatting. A text shape's height is
  measured in the browser when typing finishes, so two browsers with
  different fonts may draw the same text slightly differently.
- **The log is never compacted.** It's capped per room and overall instead.
  Snapshots keep loading fast, but disk use only goes up until a cap is hit.
- **Tested on Linux with Chromium.** Other browsers and operating systems
  should work but I haven't run them.

## Documentation

- [Wire protocol](docs/protocol.md): every message, shape kinds, versioning
- [Client core](docs/client.md): the sync engine, reconnect and resync
- [Canvas UI](docs/frontend.md): interaction, rendering, text, shortcuts
- [Server hardening](docs/hardening.md): limits, rate limiting, shutdown
- [Deployment](docs/deployment.md): Docker, Koyeb, Vercel

## License

MIT, see [`LICENSE`](LICENSE).
