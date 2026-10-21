import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.95 ships Node 20 in the extension host.
  target: "node20",
  // Resolve workspace packages to their TypeScript source (see ADR-0002).
  conditions: ["source"],
  // Minify one-off builds (smaller .vsix); keep watch builds readable.
  minify: !watch,
  logLevel: "info",
};

const builds = [
  {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    // `vscode` is provided by the editor at runtime.
    external: ["vscode"],
    sourcemap: true,
  },
  {
    // The RouteLens MCP server (ADR-0009), run by VS Code's own Node for Copilot agent mode
    // and copied for Claude Code and Cursor. Everything inside, TypeScript included: the
    // .vsix has no node_modules.
    ...shared,
    entryPoints: ["../mcp/src/bin.ts"],
    outfile: "dist/mcp-server.js",
  },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
