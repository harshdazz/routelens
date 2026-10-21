import * as esbuild from "esbuild";

// One file with core, zod and the MCP SDK inside (ADR-0009). CommonJS, because some SDK
// dependencies are CommonJS and call `require`. TypeScript stays out: it is a dependency, and
// only list_routes and friends load it (lazily, ~0.3 s).
await esbuild.build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/routelens-mcp.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["typescript"],
  // Resolve workspace packages to their TypeScript source (see ADR-0002).
  conditions: ["source"],
  banner: { js: "#!/usr/bin/env node" },
  minify: true,
  logLevel: "info",
});
