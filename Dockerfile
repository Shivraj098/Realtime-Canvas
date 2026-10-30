# syntax=docker/dockerfile:1
#
# The WebSocket server, as a small image.
#
# Three stages:
#   deps   production dependencies of the server only (ws, zod, better-sqlite3).
#          Only package.json files are copied in, so this layer is rebuilt only
#          when dependencies change, not on every code change.
#   build  all dependencies, then the esbuild bundle (the build also runs the
#          smoke test against the bundle it just made).
#   run    node + the two things above, as an unprivileged user.
#
# Debian ("slim"), not Alpine: better-sqlite3 downloads a prebuilt binary for
# glibc. Alpine uses musl, where that download may not exist and the install
# would need a compiler.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --workspace=server --include-workspace-root
COPY shared shared
COPY server server
RUN npm run build --workspace=server

FROM node:${NODE_VERSION}-bookworm-slim AS run
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/ops.sqlite
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY server/package.json server/package.json
COPY package.json package.json

# The database lives on a volume mounted at /data. Created here so that running the
# image without a volume (a quick local try) still works, as the unprivileged user.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# `node` directly (not `npm start`) so SIGTERM reaches the server, which closes
# connections and saves room snapshots before exiting.
CMD ["node", "server/dist/index.js"]
