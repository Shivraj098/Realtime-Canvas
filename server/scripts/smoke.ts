import { spawn, spawnSync } from "node:child_process";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@realtime-canvas/shared";

/**
 * Smoke test for the *built artifact*. Unit and integration tests run the
 * TypeScript source, so they cannot catch a bundle that builds but fails to
 * start (a missing native module, a bad import path, an ESM/CJS mismatch).
 * This runs dist/index.js exactly the way production will and checks:
 *   1. production mode refuses to start without an origin allowlist,
 *   2. a configured server answers the health check,
 *   3. a WebSocket from an allowed origin joins, one from another origin is refused,
 *   4. SIGTERM shuts it down cleanly (exit code 0) with a client still connected,
 *      which is how a hosting platform stops a container.
 *
 * Check 4 needs real signals, which Windows does not have: there,
 * `child.kill("SIGTERM")` ends a Node process on the spot, without running its
 * shutdown handler, so a "clean exit" can never be observed. On Windows the
 * check is skipped (and says so) and the process is simply ended. Linux and
 * macOS, and the CI that runs on Linux, still enforce it. Production is a Linux
 * container, which is where it matters.
 */

const TIMEOUT_MS = 20_000;

/** SMOKE_SKIP_GRACEFUL=1 forces the Windows behaviour on any platform, so it can be tested. */
const canCheckGracefulShutdown = process.platform !== "win32" && process.env.SMOKE_SKIP_GRACEFUL !== "1";
const ALLOWED_ORIGIN = "https://smoke.example";

function failNow(message: string): never {
  console.error(`smoke test FAILED: ${message}`);
  process.exit(1);
}

// 1. Unsafe production configuration must be refused at startup.
const unsafe = spawnSync(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    PORT: "0",
    DB_PATH: ":memory:",
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "",
    ALLOW_ANY_ORIGIN: "",
  },
  encoding: "utf8",
  timeout: 10_000,
});
if (unsafe.status !== 1 || !unsafe.stderr.includes("ALLOWED_ORIGINS")) {
  failNow(
    `production without ALLOWED_ORIGINS should exit 1 naming it, got status ${unsafe.status}: ${unsafe.stderr}`,
  );
}

// 2-4. A properly configured production server.
const child = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    PORT: "0",
    DB_PATH: ":memory:",
    NODE_ENV: "production",
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

function fail(message: string): never {
  child.kill("SIGKILL");
  return failNow(message);
}

const timer = setTimeout(() => fail(`no result within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

let askedToStop = false;
child.on("exit", (code, signal) => {
  if (!askedToStop) fail(`server exited early (code ${code}, signal ${signal})`);
  if (canCheckGracefulShutdown && code !== 0) {
    fail(`server did not shut down cleanly on SIGTERM (code ${code}, signal ${signal})`);
  }
  clearTimeout(timer);
  const checked = "refused unsafe production config, served /health, enforced origins";
  console.log(
    canCheckGracefulShutdown
      ? `smoke test passed: ${checked}, exited 0 on SIGTERM`
      : `smoke test passed: ${checked} (graceful-shutdown check skipped: this platform cannot deliver SIGTERM to Node)`,
  );
  process.exit(0);
});

async function checkHealth(port: string): Promise<void> {
  const response = await fetch(`http://localhost:${port}/health`);
  const body = (await response.json()) as { status?: string };
  if (response.status !== 200 || body.status !== "ok")
    fail(`/health returned ${response.status} ${JSON.stringify(body)}`);
}

function checkOriginRefused(port: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://localhost:${port}`, { origin: "https://elsewhere.example" });
    socket.on("open", () => fail("a connection from a disallowed origin was accepted"));
    socket.on("unexpected-response", (_request, response) => {
      if (response.statusCode !== 403)
        fail(`a disallowed origin got status ${response.statusCode}, expected 403`);
      resolve();
    });
    socket.on("error", () => {});
  });
}

function joinAndShutDown(port: string): void {
  const socket = new WebSocket(`ws://localhost:${port}`, { origin: ALLOWED_ORIGIN });
  socket.on("error", (error) => fail(`websocket error: ${error.message}`));
  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        type: "join_room",
        protocolVersion: PROTOCOL_VERSION,
        roomId: "smoke",
        clientId: "smoke-client",
        sinceSeq: 0,
      }),
    );
  });
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type: string };
    if (message.type !== "sync_snapshot") return;
    // Leave the connection open on purpose: a graceful shutdown must cope with live clients.
    askedToStop = true;
    // Where signals do not exist, SIGKILL is what kill() amounts to anyway: say what happens.
    child.kill(canCheckGracefulShutdown ? "SIGTERM" : "SIGKILL");
  });
}

let output = "";
child.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
  const match = /ws:\/\/localhost:(\d+)/.exec(output);
  if (!match) return;
  child.stdout.removeAllListeners("data");
  const port = match[1]!;
  checkHealth(port)
    .then(() => checkOriginRefused(port))
    .then(
      () => joinAndShutDown(port),
      (error: unknown) => fail(String(error)),
    );
});
