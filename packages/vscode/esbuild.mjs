import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.95 ships Node 20 in the extension host.
  target: "node20",
  // `vscode` is provided by the editor at runtime.
  external: ["vscode"],
  // Resolve workspace packages to their TypeScript source (see ADR-0002).
  conditions: ["source"],
  sourcemap: true,
  // Minify one-off builds (smaller .vsix); keep watch builds readable.
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
