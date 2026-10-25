import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Workspace packages are consumed from TypeScript source, as in the server and the tests.
export default defineConfig({
  resolve: {
    alias: {
      "@realtime-canvas/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  build: { target: "es2022", sourcemap: true },
  server: { port: 5173 },
});
