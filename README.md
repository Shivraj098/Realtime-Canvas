# realtime-canvas

A real-time collaborative whiteboard. Multiple people open the same room
and see each other's shapes and cursors update live.

The point of this project isn't the whiteboard itself — it's the
distributed-systems problem underneath it: **when two people edit the
same thing at the same time over an unreliable network, what happens?**

**In one sentence:** concurrent edits are resolved using Hybrid Logical
Clocks instead of wall-clock timestamps, with a persisted, sequenced
operation log so a client that disconnects and reconnects re-syncs only
what it missed, not the entire room state.

## Architecture

```
shared/   - protocol types, Hybrid Logical Clock, CRDT-lite reconciliation
            (imported identically by both client and server - single
            source of truth for "how conflicts resolve")
server/   - WebSocket server, room/presence management, SQLite-backed
            append-only op log
client/   - Vite + TypeScript canvas UI
```

See [`shared/src/hlc.ts`](shared/src/hlc.ts) and
[`shared/src/reconcile.ts`](shared/src/reconcile.ts) for the core
conflict-resolution logic, with test coverage in the adjacent
`*.test.ts` files.

## Documentation

[Wire protocol](docs/protocol.md) · [Client core](docs/client.md) ·
[Canvas UI](docs/frontend.md) · [Server hardening](docs/hardening.md) ·
[Deployment](docs/deployment.md)

## Status

Built in phases, each with its own tested, committed, CI-passing
checkpoint.

- [x] **Phase 1 — Foundation**: monorepo tooling (ESLint, Prettier,
      Vitest, CI), Hybrid Logical Clock, wire protocol, per-field LWW
      reconciliation — all test-covered
- [x] **Phase 2 — Server**: WebSocket server, room management, SQLite op
      log, reconnect/replay
- [x] **Phase 3 — Client core**: connection handling, local state store
- [x] **Phase 4 — Client canvas**: seven shape kinds (rectangle, ellipse,
      diamond, triangle, line, arrow, text), labels, drag/resize/delete,
      duplicate, PNG export, live cursors
- [x] **Phase 5a — Hardening**: health check, heartbeat, origin allowlist,
      rate limits, capacity caps, idle-room eviction and snapshots
- [ ] **Phase 5b — Deployment**: Dockerized server on Koyeb (free instance),
      static client on Vercel (config and guide in
      [`docs/deployment.md`](docs/deployment.md); tick this and add the live link
      once it is up)

> **Live demo note:** the free server sleeps when idle and has no persistent
> disk, so the first connection after a quiet spell is slow and boards reset
> when it restarts. The same image keeps its boards on any host with a disk
> mounted at `/data`.

## Development

Requires Node.js 22.12 or newer.

```bash
npm install
npm run lint          # ESLint
npm run format:check  # Prettier
npm run typecheck     # TypeScript, all workspaces
npm run test          # Vitest
npm run build         # production build, all workspaces
```
