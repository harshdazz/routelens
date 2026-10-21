import { readdir } from "node:fs/promises";
import path from "node:path";
import { readTextIfExists } from "./packageJson.js";
import { toPort } from "./scripts.js";

// Finds the port in server code such as `app.listen(4000)` with plain text matching.
// This is a cheap heuristic for M2: no parser, no code is run. Route scanning (M3) uses ts-morph.

export interface CodePort {
  port: number;
  /** 1-based line of the `listen(` / `serve(` call. */
  line: number;
}

/** Common server entry files, checked after the files named in the start script. */
const COMMON_ENTRY_NAMES = ["server", "index", "app", "main"];
const ENTRY_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"];
const ENTRY_DIRS = ["", "src"];
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Look for a port in the server's entry files: the files named in the start script first,
 * then `main` from package.json, then common names (`server.js`, `src/index.ts`, ...).
 * Returns the file (relative to `dir`, forward slashes) and line.
 */
export async function findPortInCode(
  dir: string,
  preferredFiles: readonly string[],
): Promise<(CodePort & { file: string }) | undefined> {
  const files = [...preferredFiles, ...(await commonEntryFiles(dir))];
  const seen = new Set<string>();
  for (const file of files) {
    const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
    if (seen.has(normalized) || normalized.startsWith("..")) continue;
    seen.add(normalized);
    const text = await readTextIfExists(path.join(dir, normalized));
    if (text === undefined || text.length > MAX_FILE_BYTES) continue;
    const found = findListenPort(text);
    if (found) return { ...found, file: normalized };
  }
  return undefined;
}

/**
 * Find the first `listen(...)` or `serve(...)` call with a port we can read:
 * `listen(4000)`, `listen(process.env.PORT || 4000)`, `listen(PORT)` with
 * `const PORT = Number(process.env.PORT ?? 4000)`, `listen({ port: 4000 })`,
 * `serve({ fetch: app.fetch, port: 8787 })`.
 */
export function findListenPort(source: string): CodePort | undefined {
  const code = stripComments(source);
  for (const match of code.matchAll(/\b(?:listen|serve)\s*\(/g)) {
    const args = readArguments(code, match.index + match[0].length);
    const port = portFromArguments(args, code);
    if (port !== undefined) {
      return { port, line: code.slice(0, match.index).split("\n").length };
    }
  }
  return undefined;
}

async function commonEntryFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const sub of ENTRY_DIRS) {
    let names: Set<string>;
    try {
      names = new Set(await readdir(path.join(dir, sub)));
    } catch {
      continue;
    }
    for (const base of COMMON_ENTRY_NAMES) {
      for (const extension of ENTRY_EXTENSIONS) {
        if (names.has(base + extension)) files.push(path.posix.join(sub, base + extension));
      }
    }
  }
  return files;
}

/** Blank out comments but keep line breaks, so line numbers stay right. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The text between `(` (already consumed) and its matching `)`. */
function readArguments(code: string, start: number): string {
  let depth = 0;
  for (let index = start; index < code.length; index++) {
    const char = code[index];
    if (char === "(" || char === "{" || char === "[") depth++;
    if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) return code.slice(start, index);
      depth--;
    }
  }
  return code.slice(start);
}

/** Split on top-level commas only. */
function splitArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of args) {
    if (char === "(" || char === "{" || char === "[") depth++;
    if (char === ")" || char === "}" || char === "]") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function portFromArguments(args: string, code: string): number | undefined {
  const [first = ""] = splitArguments(args);
  // listen(4000) · listen(PORT, cb) · listen(process.env.PORT || 4000)
  const direct = first.startsWith("{") ? undefined : evaluate(first, code, 0);
  if (direct !== undefined) return direct;
  // listen({ port: 4000 }) · serve({ fetch, port }) · serve(app, { port: 3000 })
  const property = /\bport\s*:\s*([^,}]+)/.exec(args);
  if (property?.[1]) return evaluate(property[1], code, 0);
  if (/[{,]\s*port\s*[,}]/.test(args)) return evaluate("port", code, 0);
  return undefined;
}

/** Best-effort value of a port expression. Follows a variable at most twice. */
function evaluate(expression: string, code: string, depth: number): number | undefined {
  // parseInt(x, 10): the radix is not a port.
  const text = expression.replace(/,\s*10\s*\)/g, ")").trim();
  const number = /(?<![\w.$])(\d{2,5})(?![\w.])/.exec(text);
  if (number) return toPort(number[1]);

  const identifier = /^[A-Za-z_$][\w$]*$/.exec(text)?.[0];
  if (!identifier || depth >= 2) return undefined;
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=\\s*([^;\\n]+)`).exec(
    code,
  );
  return declaration?.[1] ? evaluate(declaration[1], code, depth + 1) : undefined;
}
