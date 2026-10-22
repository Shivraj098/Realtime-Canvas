import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace package from its TypeScript source (the same
// mapping tsconfig.json uses for typechecking and esbuild uses for
// bundling). This keeps the dev loop free of build-ordering: editing
// shared/ is immediately visible to the server's tests, with no
// "rebuild shared first" step to forget.
export default defineConfig({
  resolve: {
    alias: {
      "@realtime-canvas/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
