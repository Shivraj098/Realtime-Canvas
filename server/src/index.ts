import { createServer } from "./app";
import { ConfigError, loadConfig } from "./config";

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  // A bad setting should stop the process with a readable list, not a stack trace.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

const server = createServer(config);
console.log(`realtime-canvas server listening on ws://localhost:${server.port}`);
if (config.allowedOrigins && config.allowedOrigins.length > 0) {
  console.log(`accepting WebSocket connections from: ${config.allowedOrigins.join(", ")}`);
} else {
  console.warn(
    "WARNING: ALLOWED_ORIGINS is not set, so any website may connect. Fine for local development.",
  );
}

// Hosting platforms stop a container with SIGTERM. Closing cleanly means
// connected clients get a proper close, each room's state is saved, and
// SQLite is shut down instead of being killed mid-write.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  // Never hang the platform's stop: give up after a few seconds.
  setTimeout(() => {
    console.error("shutdown took too long; exiting anyway");
    process.exit(1);
  }, 8000).unref();
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
// Ctrl+Break in a Windows console. A name Node does not know on other platforms is just an unused event.
process.on("SIGBREAK", shutdown);
