# Deployment

Two pieces, two hosts:

| Piece                     | Host   | Why                                                                                         |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| Web app (static files)    | Vercel | It is only HTML, CSS and JavaScript. A CDN is the right place.                              |
| WebSocket server + SQLite | Fly.io | It needs a long-lived process, a persistent disk, and WebSocket connections that stay open. |

```
browser ──https──▶ Vercel (static files)
   │
   └────wss────▶ Fly.io  ──▶ server process ──▶ SQLite file on a Fly volume (/data)
```

Vercel's serverless functions cannot hold a WebSocket open, and they have no disk that
survives, which is why the server is not there.

## What is in the repo

| File            | Purpose                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `Dockerfile`    | Builds the server image: deps stage, build stage (runs the smoke test), small runtime. |
| `fly.toml`      | One machine, one volume at `/data`, health check on `/health`, no auto-stop.           |
| `vercel.json`   | Builds the client from the repo root; security headers including a CSP.                |
| `.dockerignore` | Keeps `node_modules`, the database and the client out of the image.                    |

CI builds the image, starts it, checks `/health` and checks that `docker stop` exits 0.

## Settings

| Variable             | Where it is set             | Value                                                                                                                              |
| -------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`    | Fly secret (required)       | Your web app's origin, e.g. `https://my-whiteboard.vercel.app`. Comma-separate several. `https://*.example.com` allows subdomains. |
| `NODE_ENV`           | `fly.toml`                  | `production`. The server refuses to start without `ALLOWED_ORIGINS` in this mode, on purpose.                                      |
| `DB_PATH`            | `fly.toml`                  | `/data/ops.sqlite`, on the volume.                                                                                                 |
| `MIN_ROOM_ID_LENGTH` | `fly.toml`                  | `16`: the app makes 128-bit ids, so short guessable ones are refused.                                                              |
| `VITE_WS_URL`        | Vercel environment variable | `wss://<your-fly-app>.fly.dev`. Read at **build** time.                                                                            |

Every other limit and its default is in [`hardening.md`](hardening.md). No secret is
involved anywhere: the only protection is the unguessable room id and the origin allowlist.

## Steps

You need accounts on [Fly.io](https://fly.io) (it asks for a card) and
[Vercel](https://vercel.com), and the Fly CLI (`fly`).

Pick the two names first, because each service needs the other's address:
a Vercel project name (the address is `https://<name>.vercel.app`) and a Fly app
name (`https://<name>.fly.dev`).

### 1. Server on Fly.io

```bash
fly auth login
# Edit fly.toml: set `app` to your Fly app name and `primary_region` to a region near you.
fly apps create <your-fly-app>
fly volumes create data --size 1 --region <primary_region> --yes
fly secrets set ALLOWED_ORIGINS=https://<your-vercel-name>.vercel.app
fly deploy
fly status
curl https://<your-fly-app>.fly.dev/health
```

The health check answers JSON once the server is up. A failed deploy usually means the
secret is missing or malformed; `fly logs` prints the exact problem.

### 2. Web app on Vercel

1. Vercel dashboard, **Add New Project**, import the GitHub repo.
2. Keep **Root Directory** as the repo root (the client imports the `shared` package,
   so it cannot be built from `client/` alone). `vercel.json` sets the install and build
   commands and the output folder.
3. Name the project the same as in `ALLOWED_ORIGINS`.
4. Add environment variable `VITE_WS_URL` = `wss://<your-fly-app>.fly.dev`.
5. Deploy.

If you change `VITE_WS_URL` later, **redeploy**: it is baked into the build.

### 3. Check it

Open the Vercel address in two browsers (or one normal and one private window), copy the
link from one into the other, and draw. You should see shapes and cursors on both. Then:

```bash
fly deploy                   # redeploy: open boards reconnect and keep their shapes
fly machine restart <id>     # the volume keeps every room
```

## Why one machine

Each room's state is cached in the memory of the process that serves it, and the log is a
SQLite file on that machine's disk. A second machine would have its own, different copy
of every room, and two people in the same room could land on different machines and never
see each other. So `fly.toml` runs exactly one machine, and `auto_stop_machines` is off
(stopping it would drop every open connection).

Scaling past one machine needs a shared log and a way to fan messages out between
processes (a database such as Postgres plus pub/sub). That is a different design and is
deliberately out of scope; this one handles a few hundred connections (see `soft_limit`).

## Operating notes

- **Backups.** Fly takes daily snapshots of the volume. For a portfolio demo that is
  enough; for anything you cannot lose, copy `/data/ops.sqlite` out with `fly ssh sftp`.
- **Logs.** `fly logs`. The server logs refused origins, limit hits and shutdown.
- **Cost.** One `shared-cpu-1x` 512 MB machine plus a 1 GB volume is a few dollars a month
  at Fly's current prices; check their pricing page. Vercel's free tier is enough.
- **Preview deploys.** Vercel gives each branch its own address, and the server will
  refuse them unless they are in `ALLOWED_ORIGINS`. The wildcard must be a whole leading
  label, so `https://*.vercel.app` is the only pattern that covers them, and it lets any
  Vercel site connect. The room id is still the real protection, so that is a reasonable
  trade for a demo; for anything stricter, add preview addresses one at a time.
- **Custom domain.** Add it in Vercel, then add its origin to `ALLOWED_ORIGINS` (comma
  separated) and run `fly secrets set` again; the machine restarts with the new value.
