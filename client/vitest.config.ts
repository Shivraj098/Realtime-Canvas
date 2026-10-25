import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve workspace packages from TypeScript source, as the server does.
// `@realtime-canvas/server` is only used by the convergence tests, which
// run the real server in-process; production client code never imports it.
export default defineConfig({
  resolve: {
    alias: {
      "@realtime-canvas/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@realtime-canvas/server": fileURLToPath(new URL("../server/src/app.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
