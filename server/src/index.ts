import { createServer } from "./app";

function readPort(value: string | undefined): number {
  const port = value === undefined ? 8080 : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT "${value}": expected an integer between 0 and 65535`);
  }
  return port;
}

const port = readPort(process.env.PORT);
const dbPath = process.env.DB_PATH ?? "./data/ops.sqlite";

const server = createServer({ port, dbPath });
console.log(`realtime-canvas server listening on ws://localhost:${server.port}`);

// Hosting platforms stop a container with SIGTERM. Closing cleanly means
// connected clients get a proper close and SQLite is shut down instead of
// being killed mid-write.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  server.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error("error during shutdown", error);
      process.exit(1);
    },
  );
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
