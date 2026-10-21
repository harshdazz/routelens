import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against core's TypeScript source, so no build step is needed first (ADR-0002).
    alias: {
      "@routelens/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // The acceptance check installs a real project (npm ci): run it with `pnpm test:acceptance`.
    exclude: [...configDefaults.exclude, "test/acceptance/**"],
  },
});
