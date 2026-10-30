# Client core

The client library that the canvas UI sits on. It has no UI and no
DOM dependency: it keeps one room's state consistent with the server and
survives bad networks. Source: [`client/src`](../client/src).

```
RoomClient            wires the pieces below; what the UI talks to
├── SyncEngine        pure state machine: confirmed state + pending queue
└── RoomSocket        one self-healing WebSocket: backoff, jitter, validation
```

## SyncEngine: confirmed state plus a pending queue

- **`confirmed`** is built only from the server's `sync_snapshot` and `op_ack`
  messages, folded through the same `applyOp` the server uses. It is what the
  server has.
- **`pending`** is the queue of local ops the server has not acknowledged,
  whether or not they were sent yet.
- **The view** the user sees is derived: `confirmed` with every pending op
  applied on top. So there is nothing to undo when the server rejects an op:
  dropping it from the queue is the rollback.

Pending ops are applied to the view as if they came _after_ everything
confirmed, because the server stamps ops in arrival order. Using the client's
own timestamp would make a user's edit lose to a concurrent remote edit until
the ack arrived, then flip back.

### What happens on each server message

| Message                  | Effect                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_snapshot`          | Replace `confirmed` and `lastSeq`. Pending edits stay and are re-applied on top.                                                                            |
| `op_ack`                 | `seq <= lastSeq`: already applied; only stop waiting for it. `seq == lastSeq + 1`: apply it. Anything higher is a **gap**: apply nothing, ask for a resync. |
| `op_reject`              | Remove that op from `pending`. The view rolls back by itself.                                                                                               |
| `presence`               | One entry per `clientId`; cursors and previews of people who left are forgotten.                                                                            |
| `cursor`, `drag_preview` | Ephemeral state. A preview is cleared when an ack for its shape arrives, or by `expirePreviews`.                                                            |

## RoomSocket: reconnecting without a stampede

On a dropped connection it waits `min(1000 * 2^n, 15000)` ms plus up to 30%
random jitter, then reconnects. The jitter matters: after a server restart,
every client would otherwise retry in synchronised waves. The counter resets
once the server speaks, not merely once the socket opens, so a server that
accepts and immediately drops connections cannot pin clients to a 1 s retry.

- A close with code **4001** (unsupported protocol version) is final: no retry.
- Every handler checks that its socket is still _the_ socket, so a late event
  from an abandoned connection cannot be mistaken for the current one.
- Binary frames and anything that is not a well-formed server message are
  dropped and counted (`parseServerMessage`).

## RoomClient: the reconnect sequence

On every (re)connection, in this order:

1. send `join_room` with `sinceSeq = lastSeq`, so the server replays only what
   was missed (or sends a snapshot for a fresh client);
2. re-send every pending op, oldest first, with its **original `opId`**. The
   server de-duplicates by `opId`, so an op it already has is answered with its
   stored ack and not applied twice.

`RoomClient.retryNow()` cuts a backoff wait short. The canvas app calls it when the
browser fires `online` and when the tab becomes visible; it does nothing on a healthy connection.

The catch-up is **paced**: ops are re-sent 10 at a time, 600 ms apart (below the
server's default allowance of 20 ops a second), and strictly in their original order.
A new edit made while older ones are still waiting joins the back of the line, so an
update can never reach the server before the create it depends on. If the server
still answers `rate_limited`, the engine KEEPS the op (it is not a verdict on the op)
and the client sends it again after a pause.

If the engine reports a gap in the op stream, the client reconnects (after the
normal backoff) and resumes from `lastSeq`.

## Decisions made here

| Decision                     | Choice                                                    | Why                                                                                     |
| ---------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `clientId`                   | One per `RoomClient`, i.e. per browser tab                | Two tabs are two replicas; a shared id would confuse presence.                          |
| Offline edits                | Queued (up to 1000), sent on reconnect                    | Work is not lost; the cap bounds memory. Beyond it edits are refused.                   |
| Local validation             | Refuse edits to unknown or deleted shapes before queueing | Avoids sending ops the server is certain to reject.                                     |
| State container              | Plain typed class with `subscribe`, no framework          | The UI wraps it in whatever it needs.                                                   |
| Client clock vs server clock | No drift limit on the client's HLC                        | The server restamps every op; the client's timestamps only order its own pending edits. |

## How it is tested

| Layer                      | Tests                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyncEngine`               | Unit tests: every message type, rollback, gaps, snapshots, queue limit, previews.                                                                                                                                                                                                                       |
| `RoomSocket`, `RoomClient` | Unit tests with a hand-driven fake socket and fake timers: exact backoff schedule, stale-socket events, reconnect sequence.                                                                                                                                                                             |
| Convergence                | Real clients, real server, real SQLite. Faults are injected around the sockets: delay, silent loss in either direction, abrupt disconnects. Scenarios cover lost acks, lost ops, offline edits, rejected edits, replay vs snapshot, and gap recovery.                                                   |
| Property test              | `fast-check` generates random mixes of edits and faults across three clients, then heals the network and asserts that every client, the server's log, and a brand-new joiner hold the same state, and that every op was either applied exactly once or rejected. Set `FC_SEED` to replay a failing run. |

## Known limits

- A connection that dies silently is detected by the SERVER's ping/pong, which drops
  it; the client itself cannot see pings (browsers answer them invisibly), so it
  learns of a dead link when the socket closes.
- If the server refuses ops as too fast while later, dependent ops are already in
  flight, those later ops can be refused for good (`unknown_shape`). The paced
  catch-up keeps a normal client well below the limit, so this needs a scripted
  burst to happen.
- Cursor and drag-preview throttling is left to the UI, which knows its frame loop.
- A server-side failure while storing an op gives no reject: the op simply stays
  pending and is re-sent on the next reconnect.
