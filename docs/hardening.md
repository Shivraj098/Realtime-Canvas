# Hardening

What the server does to stay up when anyone with a link can talk to it, and what
it deliberately does not do. Source: [`server/src`](../server/src).

## The situation

There are no accounts. A room is protected by its id, and the web app makes ids
from 128 random bits, so only people given the link can find a room. Everything
below assumes that: **the room id is the access control.** The rest is about not
letting one participant, or one stranger, use up the server.

| Resource a stranger could spend | Protection                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| Connections                     | A global cap (503 at the handshake), and a heartbeat that drops dead ones.         |
| CPU and bandwidth               | Per-connection token buckets for ops and for cursor/preview traffic.               |
| Patience of the log             | Malformed or excess messages cost "strikes"; run out and the connection is closed. |
| Memory                          | Caps on rooms in memory and people per room; idle rooms are evicted.               |
| Disk                            | Caps on shapes per room, ops per room, and ops overall.                            |
| Guessing a room                 | An optional minimum room-id length, so short names like `demo` are refused.        |
| Other websites                  | An `Origin` allowlist on the WebSocket handshake.                                  |

## Rate limiting

Each connection has two **token buckets**: one for ops (create, update, delete) and
one for ephemeral traffic (cursors, drag previews). A bucket starts full and refills
at a steady rate, so a short burst is fine and a sustained flood is not. Ops and
ephemeral traffic are separate so a busy cursor cannot starve a real edit.

- Excess **ops** get `op_reject: rate_limited`. That is a request to slow down, not
  a verdict on the op: the client keeps it and sends it again.
- Excess **ephemeral** messages are dropped without a reply. They are stale in a
  second anyway, and replying to each would only add traffic.
- Either kind, and every malformed frame, costs a **strike**. Strikes recover at 5 a
  second; a connection that runs out is told why (`rate_limited`) and closed (1008).

The defaults (20 ops a second, bursts of 40; 90 ephemeral a second, bursts of 180) are
well above what a person can do with a mouse, and the client paces its own catch-up
below them.

## Caps

A cap is checked after an op is known to be new and valid, so a **retry of an op that
is already stored is still answered** even when the room is full.

- **Shapes per room** counts deleted shapes too, because they stay as tombstones.
- **Ops per room** bounds a room's log. **Total ops** bounds the database.
- **Rooms in memory** bounds concurrent activity, not how many rooms exist: idle rooms
  are evicted and reload on demand.

## Idle rooms and snapshots

A room in memory is a cache of its op log. Loading one would mean replaying its whole
log, so the server saves a **snapshot** of the folded state every 500 ops and when a
room is evicted or the server shuts down. Loading then replays only the ops after the
snapshot. The log itself is never trimmed, so:

- a missing, unreadable or inconsistent snapshot is ignored and the room rebuilt from
  the whole log (it is a cache, never the truth);
- reconnecting clients still get exactly the ops they missed.

Rooms with nobody in them are dropped from memory after 5 minutes.

## Origin allowlist

Browsers attach an `Origin` header to every WebSocket handshake and page scripts cannot
change it. With `ALLOWED_ORIGINS` set, the server refuses (403) any handshake whose
origin is not listed, which stops other websites using a visitor's browser to talk to
this server. A pattern is `scheme://host[:port]`, or `scheme://*.host` for any
subdomain (the bare domain is not matched).

**It is not authentication.** Anything outside a browser can send any `Origin`. The room
id remains the only thing that protects a room.

In production (`NODE_ENV=production`) the server **refuses to start** without
`ALLOWED_ORIGINS`, unless `ALLOW_ANY_ORIGIN=true` says so on purpose.

## Health check and shutdown

`GET /health` returns `200 {"status":"ok", ...}` with counts only (never room ids), or
`503` if the database cannot be read. Hosting platforms use it to decide whether to
route traffic.

On `SIGTERM` the server stops accepting connections, saves every room's snapshot, closes
clients, shuts SQLite down, and exits 0. It gives up after 8 seconds rather than hang the
platform's stop.

Windows cannot deliver `SIGTERM` to a Node process (a kill there ends it immediately), so
the build's smoke test checks the clean exit only on Linux and macOS and says when it
skips it. Production runs in a Linux container, and CI runs on Linux, so the check still
guards what ships. `Ctrl+C` and `Ctrl+Break` in a Windows console are handled.

## Configuration

All settings are environment variables, validated at startup (a bad value stops the
process with a list of every problem).

| Variable                                  | Default             | Meaning                                                             |
| ----------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| `PORT`                                    | `8080`              | Port to listen on (`0` = any free port).                            |
| `DB_PATH`                                 | `./data/ops.sqlite` | SQLite file (`:memory:` for a throwaway database).                  |
| `NODE_ENV`                                |                     | `production` enables the origin safeguard above.                    |
| `ALLOWED_ORIGINS`                         | (empty)             | Comma-separated origins allowed to connect. Empty = any (dev only). |
| `ALLOW_ANY_ORIGIN`                        |                     | `true` to run production without an allowlist, on purpose.          |
| `MIN_ROOM_ID_LENGTH`                      | `1`                 | Refuse shorter room ids. The web app makes 22-character ones.       |
| `MAX_CONNECTIONS`                         | `500`               | Open WebSocket connections.                                         |
| `MAX_ROOMS`                               | `500`               | Rooms in memory at once.                                            |
| `MAX_CLIENTS_PER_ROOM`                    | `50`                | People in one room.                                                 |
| `MAX_SHAPES_PER_ROOM`                     | `2000`              | Shapes a room may ever contain (deleted ones count).                |
| `MAX_OPS_PER_ROOM`                        | `20000`             | Ops one room may store.                                             |
| `MAX_TOTAL_OPS`                           | `500000`            | Ops stored across all rooms.                                        |
| `OPS_PER_SECOND`, `OPS_BURST`             | `20`, `40`          | Sustained and burst allowance for ops, per connection.              |
| `EPHEMERAL_PER_SECOND`, `EPHEMERAL_BURST` | `90`, `180`         | The same for cursors and previews.                                  |
| `VIOLATIONS_BEFORE_CLOSE`                 | `100`               | Strikes tolerated in a burst.                                       |
| `HEARTBEAT_INTERVAL_MS`                   | `30000`             | Ping interval (`0` disables).                                       |
| `ROOM_IDLE_MS`                            | `300000`            | How long an empty room stays in memory.                             |
| `SNAPSHOT_EVERY`                          | `500`               | Ops between snapshots.                                              |
| `MAX_PAYLOAD_BYTES`                       | `65536`             | Largest accepted frame.                                             |

## What this does not do

Being honest about the edges is part of the design:

- **No authentication or per-user identity.** Anyone with a link is a full editor.
  A leaked link needs a new room.
- **No per-IP limits.** Limits are per connection, so one machine opening many
  connections gets many allowances. The global caps bound the damage; per-IP limiting
  belongs at the edge (the hosting platform's proxy), where the real client address is known.
- **No protection against a large distributed attack.** That is the hosting platform's job.
- **The log is capped, not compacted.** Disk use is bounded by the caps, but a busy room
  reaches its cap and then refuses edits; trimming old ops safely (clients behind the trim
  would need a snapshot, and the duplicate-op check relies on old rows) is future work.
- **One server instance.** Rooms live in one process's memory and one SQLite file.
- **Tombstones are never removed**, so deleting shapes does not free room capacity.
- **Cursors and previews are not authenticated either:** within a room, a client can
  show any position, but never under another person's identity (the server stamps it).
