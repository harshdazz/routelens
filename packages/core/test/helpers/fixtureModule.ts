import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import * as zod from "zod";

/**
 * Test helper: load a value declared in a fixture file (exported or not), so tests can check
 * RouteLens's samples against the route's real zod schema. The fixtures have no node_modules:
 * `zod` is the real one, project files are loaded the same way, and every other package
 * (next, express, axios) is a harmless stub. RouteLens itself never runs project code.
 */
export function loadFixtureValue(fixtureDir: string, file: string, name: string): unknown {
  const exports = loadModule(fixtureDir, path.join(fixtureDir, file), name);
  return exports.__routelensValue;
}

const stub: unknown = new Proxy(function stub() {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : stub),
  apply: () => stub,
  construct: () => stub as object,
});

function loadModule(
  fixtureDir: string,
  filePath: string,
  expose?: string,
): Record<string, unknown> {
  const source =
    readFileSync(filePath, "utf8") +
    (expose ? `\n;export const __routelensValue = ${expose};\n` : "");
  const { outputText } = ts.transpileModule(source, {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
    },
  });
  const module = { exports: {} as Record<string, unknown> };
  const require = (specifier: string): unknown => {
    if (specifier === "zod" || specifier.startsWith("zod/")) return zod;
    const local = resolveLocal(fixtureDir, filePath, specifier);
    return local ? loadModule(fixtureDir, local) : stub;
  };
  const run = vm.runInThisContext(`(function (exports, require, module) {\n${outputText}\n})`) as (
    exports: unknown,
    require: (specifier: string) => unknown,
    module: unknown,
  ) => void;
  run(module.exports, require, module);
  return module.exports;
}

/** `./x.js` → `x.ts`, `@/lib/x` → `src/lib/x.ts`, folders → `index.ts`. */
function resolveLocal(fixtureDir: string, fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else if (specifier.startsWith("@/")) base = path.join(fixtureDir, "src", specifier.slice(2));
  else return undefined;
  const stem = base.replace(/\.(m?js|cjs)$/, "");
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && !candidate.endsWith(path.sep));
}
