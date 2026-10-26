# Wire protocol

The contract between client and server. The types live in
[`shared/src/protocol.ts`](../shared/src/protocol.ts) and are imported by both
sides; the server validates every inbound frame against a matching `zod`
schema in [`server/src/validation.ts`](../server/src/validation.ts).

**Transport:** one WebSocket per client, JSON text frames only. A binary frame
is dropped. **Version:** `PROTOCOL_VERSION` (currently `2`), sent in
`join_room`.

## Two kinds of traffic

| Family                                | Messages                                     | Persisted                 | Ordered by                           |
| ------------------------------------- | -------------------------------------------- | ------------------------- | ------------------------------------ |
| **Ops** (durable state)               | `create_shape` `update_shape` `delete_shape` | yes, in the SQLite op log | server HLC, then per-room `seq`      |
| **Ephemeral** (what is happening now) | `cursor` `drag_preview`                      | never                     | not ordered; only the latest matters |

## Client to server

| Message        | Purpose                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------- |
| `join_room`    | Must be first. `{ protocolVersion, roomId, clientId, sinceSeq }`                             |
| `create_shape` | `{ shapeId, opId, hlc, fields }`                                                             |
| `update_shape` | `{ shapeId, opId, hlc, changes }`: one or more of `x y width height color`, applied together |
| `delete_shape` | `{ shapeId, opId, hlc }`                                                                     |
| `cursor`       | `{ x, y, color, ... }`, relayed to the others in the room                                    |
| `drag_preview` | `{ shapeId, changes }` with geometry fields only, relayed to the others                      |

`roomId` and `clientId` inside any message after the join are ignored and
replaced with the values from the connection. The `hlc` in an op is a hint the
server merges into its own clock; the stored op carries the **server's**
timestamp.

## Server to client

| Message                 | Meaning                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sync_snapshot`         | Full state (tombstones included) plus `latestSeq`. Sent on a fresh join, or when `sinceSeq` is beyond what the log holds. |
| `op_ack`                | An op is in the log at `seq`. Sent to everyone in the room, the sender included. Carries the server-stamped op.           |
| `op_reject`             | One specific op was refused and nothing was stored. `{ opId, reason }`.                                                   |
| `error`                 | A connection-level problem. `{ code, message }`.                                                                          |
| `presence`              | Who is connected. One entry per connection, not per `clientId`.                                                           |
| `cursor` `drag_preview` | Another client's ephemeral state.                                                                                         |

### `op_reject` reasons

| Reason          | Cause                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid`       | The op failed validation.                                                                                                               |
| `not_joined`    | Sent before `join_room`.                                                                                                                |
| `shape_exists`  | `create_shape` for an id that exists or was ever deleted. Ids are never reused.                                                         |
| `unknown_shape` | `update_shape` / `delete_shape` for a shape that does not exist or is deleted.                                                          |
| `rate_limited`  | The connection is sending ops faster than the server allows. **Transient: the op is fine, so keep it and send it again after a pause.** |
| `room_full`     | The room has reached its limit on shapes (deleted ones count) or on stored ops.                                                         |
| `server_full`   | The server as a whole has reached its limit on stored ops.                                                                              |

### `error` codes

| Code                   | Meaning                                                              | Then the server closes with |
| ---------------------- | -------------------------------------------------------------------- | --------------------------- |
| `invalid_message`      | A frame was not valid JSON, or not a valid message.                  | (stays open)                |
| `not_joined`           | A message that needs a room was sent before `join_room`.             | (stays open)                |
| `already_joined`       | A second `join_room` on the same connection.                         | (stays open)                |
| `unsupported_protocol` | `join_room.protocolVersion` is not the server's.                     | **4001** (final)            |
| `invalid_room`         | The server does not accept this room id (for example, too short).    | **4003** (final)            |
| `room_full`            | Too many people are in this room.                                    | 1013 (try again later)      |
| `server_busy`          | The server is at capacity (too many rooms or connections).           | 1013 (try again later)      |
| `rate_limited`         | The connection flooded the server with excess or malformed messages. | 1008 (policy violation)     |

A client must not reconnect automatically after a **final** close (4001, 4003):
retrying cannot succeed until something changes. Every other close is retried with
backoff.

### Limits the server enforces

The server refuses, quietly or loudly, what a stranger holding only a room link
could use to exhaust it. The numbers are configurable (see
[hardening](hardening.md)); the behaviour is part of the protocol:

- **Ops** and **ephemeral messages** (`cursor`, `drag_preview`) each have their own
  per-connection allowance. Excess ops get `op_reject: rate_limited`; excess
  ephemeral messages are dropped without a reply.
- Excess or malformed messages also cost the connection "strikes" that recover
  over time. Run out, and it is closed with 1008.
- Connections, rooms in memory, people per room, shapes per room, ops per room
  and ops overall are capped (see the reject reasons and error codes above).

## Rules a client must follow

1. **Apply acks in order and ignore stale ones.** Acks for a room arrive in
   `seq` order. Ignore any ack whose `seq` is not above the last one applied: a
   client can see the same ack twice (a replay on reconnect, then the re-ack
   for an op it re-sent).
2. **Retries are safe.** Re-send an unacknowledged op with the **same `opId`**.
   If the server already has it, it answers with the stored `op_ack` (to the
   sender only) and stores nothing. If it does not, it processes it normally.
3. **Drop rejected ops, except "too fast".** On `op_reject`, remove that op from
   the pending queue and undo any optimistic change; retrying would be refused
   again. The exception is `rate_limited`: nothing is wrong with the op, so keep
   it, and send it again after a pause (and not ahead of any older op it may
   depend on).
   Likewise, when catching up after a reconnect, re-send queued ops a few at a
   time (the reference client sends 10 every 600 ms) so a long queue does not
   trip the rate limit itself.
4. **One op per gesture.** Send `drag_preview` while dragging and commit with a
   single `update_shape` on pointer-up. Discard a remote preview when an
   `op_ack` for that shape arrives or after a short timeout: there is no "drag
   ended" message.
5. **Render only live shapes.** A deleted shape stays in state as a tombstone
   (`deletedAt`). Use `liveShapes()` from `@realtime-canvas/shared`.

## Resync

`join_room.sinceSeq` selects what the server sends first:

| `sinceSeq`               | Server sends                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `0`                      | `sync_snapshot`                                                                                  |
| `1` to `latestSeq`       | an `op_ack` for every op after `sinceSeq`, in order                                              |
| greater than `latestSeq` | `sync_snapshot` (the client is ahead of the log, for example after the server lost its database) |

A `presence` broadcast follows in every case.

## Conflict resolution

Each field of a shape is its own last-write-wins register, ordered by Hybrid
Logical Clock, so concurrent edits to different fields both survive. A delete is
final: it leaves a tombstone and wins over any update. See
[`shared/src/reconcile.ts`](../shared/src/reconcile.ts).
