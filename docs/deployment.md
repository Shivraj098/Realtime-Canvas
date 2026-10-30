# Deployment

Two pieces, two hosts, both with a free option:

| Piece                     | Host   | Why                                                                                     |
| ------------------------- | ------ | --------------------------------------------------------------------------------------- |
| Web app (static files)    | Vercel | It is only HTML, CSS and JavaScript. A CDN is the right place.                          |
| WebSocket server + SQLite | Koyeb  | It needs a long-lived process and WebSocket connections that stay open (free instance). |

```
browser ──https──▶ Vercel (static files)
   │
   └────wss────▶ Koyeb ──▶ server process ──▶ SQLite file (/data/ops.sqlite, not persistent on the free instance)
```

Vercel's serverless functions cannot hold a WebSocket open, which is why the server is not there.

## What the free tier means for this app (read this first)

The free Koyeb instance is a real server that runs your Docker image, but with two limits that
matter here (terms checked in October 2026; free tiers change, so recheck before relying on them):

- **It sleeps when idle** (scales to zero after roughly an hour with no traffic). The next visitor
  triggers a start, so the first connection can take several seconds. The web app reconnects by
  itself with backoff, so it shows "reconnecting" and then connects; nothing needs to be done.
- **It has no persistent disk.** The SQLite file lives on the instance's own storage, which is wiped
  when the instance sleeps, restarts or redeploys. **Boards are therefore lost then.** The app is
  built for this case: a client that comes back to a server with an empty log gets a fresh
  snapshot instead of silently drifting. It is fine for a demo, where each visitor starts a new
  random room anyway. It is not fine if someone expects to return to a board tomorrow.

If you later need boards to survive, the same image runs unchanged on any host with a disk: mount
the disk at `/data` and nothing else changes. The README should say the demo resets when idle.

## What is in the repo

| File            | Purpose                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `Dockerfile`    | Builds the server image: deps stage, build stage (runs the smoke test), small runtime. |
| `vercel.json`   | Builds the client from the repo root; security headers including a CSP.                |
| `.dockerignore` | Keeps `node_modules`, the database and the client out of the image.                    |

Koyeb builds the `Dockerfile` itself, so there is no Koyeb config file; the settings are made in its
dashboard (below). CI builds the image, starts it, checks `/health` and checks that `docker stop`
exits 0, so a red Docker job means do not deploy.

## Settings

| Variable             | Where it is set             | Value                                                                                                                              |
| -------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`    | Koyeb variable (required)   | Your web app's origin, e.g. `https://my-whiteboard.vercel.app`. Comma-separate several. `https://*.example.com` allows subdomains. |
| `PORT`               | Koyeb variable              | `8080`, matching the exposed port.                                                                                                 |
| `MIN_ROOM_ID_LENGTH` | Koyeb variable              | `16`: the app makes 128-bit ids, so short guessable ones like `demo` are refused.                                                  |
| `NODE_ENV`           | `Dockerfile`                | `production`. The server refuses to start without `ALLOWED_ORIGINS` in this mode, on purpose.                                      |
| `DB_PATH`            | `Dockerfile`                | `/data/ops.sqlite`.                                                                                                                |
| `VITE_WS_URL`        | Vercel environment variable | `wss://<your-koyeb-domain>`. Read at **build** time.                                                                               |

Every other limit and its default is in [`hardening.md`](hardening.md). No secret is involved
anywhere: the only protection is the unguessable room id and the origin allowlist.

## Steps

Pick the Vercel project name first, because the server needs your site's address
(`https://<vercel-name>.vercel.app`) before the site exists. Koyeb's address, in turn, is only
known after its first deploy, so the order is: Koyeb, then Vercel.

### 1. Check CI

Push to GitHub and wait for the CI, E2E and `docker` runs to go green.

### 2. Server on Koyeb

1. koyeb.com, sign up (GitHub login works). A card is required for verification; the free
   instance is not charged.
2. **Create Service, Web Service, GitHub.** Install and authorise Koyeb's GitHub app for this
   repo, then pick the repo and the `main` branch.
3. **Builder: Dockerfile** (not Buildpack). The Dockerfile location is the default, `Dockerfile`.
4. **Instance type: Free.** Choose a region the free instance offers.
5. **Environment variables:** add `ALLOWED_ORIGINS`, `PORT` and `MIN_ROOM_ID_LENGTH` from the
   table above.
6. **Exposed ports:** port `8080`, protocol HTTP, path `/`. WebSocket connections use this same
   port.
7. **Health checks:** change the protocol from TCP to **HTTP**, port `8080`, path `/health`, and
   give it a grace period of about 30 seconds.
8. Name the service and click **Deploy**. Koyeb builds the image, starts it and waits for the
   health check.
9. When the deployment is healthy, copy the service's public address (it ends in `.koyeb.app`)
   and check it:

```bash
curl https://<koyeb-domain>/health
```

It answers JSON once the server is up. The deployment logs show which origins are accepted.

By default Koyeb redeploys on every push to `main`.

### 3. Web app on Vercel

1. Vercel dashboard, **Add New Project**, import the same GitHub repo.
2. Name the project the same as in `ALLOWED_ORIGINS`.
3. Keep **Root Directory** as the repo root (the client imports the `shared` package, so it
   cannot be built from `client/` alone) and set the framework preset to **Other**.
   `vercel.json` sets the install and build commands and the output folder.
4. Add environment variable `VITE_WS_URL` = `wss://<koyeb-domain>` (no path, no trailing slash).
5. Deploy. If the build complains about the Node version, set Node.js to 22.x in Settings.

If you change `VITE_WS_URL` later, **redeploy**: it is baked into the build.

### 4. Check it

Open the Vercel address in two browsers (or one normal and one private window), copy the link from
one into the other, and draw. You should see shapes and cursors on both.

Then test the sleeping behaviour once, so you know what a visitor sees: leave it for over an hour,
open the site, and expect a pause before it connects, then an empty board.

## Why one instance

Each room's state is cached in the memory of the process that serves it, and the log is a SQLite
file on that instance. A second instance would have its own, different copy of every room, and
two people in the same room could land on different instances and never see each other. Keep the
service at one instance.

Scaling past one instance needs a shared log and a way to fan messages out between processes (a
database such as Postgres plus pub/sub). That is a different design and is deliberately out of
scope.

## Troubleshooting

| Symptom                                     | Cause and fix                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Deployment never becomes healthy            | Read the logs. Usually `ALLOWED_ORIGINS` is missing or is not a full `https://...` origin.            |
| Health check fails but the logs look fine   | The health check must be HTTP on port `8080`, path `/health`, and `PORT` must be `8080`.              |
| Page loads but never connects               | `VITE_WS_URL` is wrong or not `wss://`. Fix it in Vercel and redeploy.                                |
| Logs say "refused a connection from origin" | The page's address is not in `ALLOWED_ORIGINS` (different project name, custom domain, preview URL).  |
| First load after a quiet spell is slow      | The instance was asleep and is starting. Expected on the free tier; the app keeps retrying.           |
| Boards vanish                               | Expected on the free tier when the instance sleeps, restarts or redeploys (see the top of this page). |
| "Out of date" on an old tab                 | Expected after a protocol change; reload the tab.                                                     |

## Operating notes

- **Backups.** There is nothing to back up on the free instance; the data is disposable by design.
- **Logs.** The service's Logs tab shows refused origins, limit hits and shutdown.
- **Cost.** Both free tiers are subject to change; check Koyeb's and Vercel's pricing pages before
  you rely on them.
- **Preview deploys.** Vercel gives each branch its own address, and the server refuses them unless
  they are in `ALLOWED_ORIGINS`. The wildcard must be a whole leading label, so
  `https://*.vercel.app` is the only pattern that covers them, and it lets any Vercel site connect.
  The room id is still the real protection, so that is a reasonable trade for a demo; for anything
  stricter, add preview addresses one at a time.
- **Custom domain.** Add it in Vercel, then add its origin to `ALLOWED_ORIGINS` (comma separated);
  Koyeb redeploys with the new value.
- **The Dockerfile `HEALTHCHECK`** is for plain Docker; Koyeb uses its own health check setting.
