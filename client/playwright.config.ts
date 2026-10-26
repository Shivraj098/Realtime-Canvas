import { defineConfig, devices } from "@playwright/test";

// Ports chosen away from the defaults (8080, 5173) so a running dev setup is not disturbed.
const SERVER_PORT = 8787;
const CLIENT_PORT = 5174;

export default defineConfig({
  testDir: "./e2e",
  // Each test uses its own room, so tests do not interfere even though they share one server.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // The real server, built by `npm run build`, with an in-memory database.
      command: "node ../server/dist/index.js",
      // A small shape limit, so the "board is full" experience can be tested without drawing thousands of shapes.
      env: { PORT: String(SERVER_PORT), DB_PATH: ":memory:", MAX_SHAPES_PER_ROOM: "25" },
      port: SERVER_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npx vite --port ${CLIENT_PORT} --strictPort`,
      env: { VITE_WS_URL: `ws://localhost:${SERVER_PORT}` },
      port: CLIENT_PORT,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
