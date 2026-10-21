import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against core's TypeScript source, so no build step is needed first (ADR-0002).
    alias: {
      "@routelens/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
