import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@realtime-canvas/shared";

/**
 * Smoke test for the *built artifact*. Unit and integration tests run the
 * TypeScript source, so they cannot catch a bundle that builds but fails to
 * start (a missing native module, a bad import path, an ESM/CJS mismatch).
 * This boots dist/index.js exactly the way production will, joins a room
 * over a real WebSocket, and checks the server answers.
 */

const TIMEOUT_MS = 10_000;

const child = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, PORT: "0", DB_PATH: ":memory:" },
  stdio: ["ignore", "pipe", "inherit"],
});

function fail(message: string): never {
  console.error(`smoke test FAILED: ${message}`);
  child.kill("SIGKILL");
  process.exit(1);
}

const timer = setTimeout(() => fail(`no result within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

child.on("exit", (code) => {
  if (code !== null && code !== 0 && code !== 143) fail(`server exited early with code ${code}`);
});

let output = "";
child.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString();
  const match = /ws:\/\/localhost:(\d+)/.exec(output);
  if (!match) return;
  child.stdout.removeAllListeners("data");

  const socket = new WebSocket(`ws://localhost:${match[1]}`);
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
    clearTimeout(timer);
    socket.close();
    child.kill("SIGTERM");
    console.log("smoke test passed: built server booted and answered join_room");
    process.exit(0);
  });
});
