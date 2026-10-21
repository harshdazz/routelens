import * as esbuild from "esbuild";

// One file with core and zod inside, so the published package needs no workspace packages
// (ADR-0008). TypeScript stays out: the CLI never scans code, so it is never loaded.
await esbuild.build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["typescript"],
  // Resolve workspace packages to their TypeScript source (see ADR-0002).
  conditions: ["source"],
  banner: { js: "#!/usr/bin/env node" },
  minify: true,
  logLevel: "info",
});
