/** The only scripts RouteLens will ever run (ADR-0006). */
export type StartScriptName = "dev" | "start";

export interface StartScript {
  name: StartScriptName;
  command: string;
}

/** A dev server we know the default port of. */
export interface DevTool {
  name: "next" | "vite" | "nest";
  label: string;
  defaultPort: number;
  /**
   * False when the tool picks its port before reading `.env`, so `PORT=` there has no effect.
   * Next.js documents this; Vite never reads `PORT` at all.
   */
  readsDotenvPort: boolean;
}

export interface ScriptInfo {
  /** A port written in the command: `-p 3001`, `--port=3001`, `PORT=3001 node server.js`. */
  explicitPort: number | undefined;
  /** A known dev server in the command, e.g. `next dev`. */
  tool: DevTool | undefined;
  /** Files the command runs, e.g. `server.js` in `node server.js`. Relative, forward slashes. */
  entryFiles: string[];
}

/** `dev` if there is one, else `start`, else nothing. */
export function pickStartScript(
  scripts: Record<string, string> | undefined,
): StartScript | undefined {
  for (const name of ["dev", "start"] as const) {
    const command = scripts?.[name];
    if (command?.trim()) return { name, command };
  }
  return undefined;
}

const ENTRY_FILE = /^[\w./@-]+\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Read the port, dev tool and entry files from a script command. Plain text, nothing is run. */
export function parseScript(command: string): ScriptInfo {
  const tokens = tokenize(command);
  return {
    explicitPort: findExplicitPort(tokens),
    tool: findTool(tokens),
    entryFiles: tokens
      .filter((token) => !token.startsWith("-") && !token.includes("=") && ENTRY_FILE.test(token))
      .map((token) => token.replace(/^\.\//, "")),
  };
}

/** Parse a port number; `undefined` unless it is a whole number from 1 to 65535. */
export function toPort(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/** Split on spaces and shell operators (`&&`, `;`, `|`), and drop quotes around words. */
function tokenize(command: string): string[] {
  return command
    .split(/[\s;&|()]+/)
    .map((token) => token.replace(/^["']+|["']+$/g, ""))
    .filter(Boolean);
}

function findExplicitPort(tokens: string[]): number | undefined {
  for (const [index, token] of tokens.entries()) {
    // PORT=3001 node server.js · cross-env PORT=3001 … · set PORT=3001&& … (Windows)
    const inline = /^PORT=(\d+)$/.exec(token);
    if (inline) return toPort(inline[1]);
    // --port=3001 · -p=3001
    const joined = /^(?:--port|-p)=(\d+)$/.exec(token);
    if (joined) return toPort(joined[1]);
    // --port 3001 · -p 3001 (the value must be a number: `tsc -p tsconfig.json` is not a port)
    if (token === "--port" || token === "-p") {
      const port = toPort(tokens[index + 1]);
      if (port !== undefined) return port;
    }
  }
  return undefined;
}

const NEXT: DevTool = { name: "next", label: "Next.js", defaultPort: 3000, readsDotenvPort: false };
const VITE: DevTool = { name: "vite", label: "Vite", defaultPort: 5173, readsDotenvPort: false };
const VITE_PREVIEW: DevTool = { ...VITE, defaultPort: 4173 };
const NEST: DevTool = { name: "nest", label: "NestJS", defaultPort: 3000, readsDotenvPort: true };

function findTool(tokens: string[]): DevTool | undefined {
  for (const [index, token] of tokens.entries()) {
    // Also matches ./node_modules/.bin/next
    const program = token.split("/").pop();
    const subcommand = tokens[index + 1];
    if (program === "next" && !["build", "lint", "info", "telemetry"].includes(subcommand ?? "")) {
      return NEXT;
    }
    if (program === "vite" && subcommand !== "build" && subcommand !== "optimize") {
      return subcommand === "preview" ? VITE_PREVIEW : VITE;
    }
    if (program === "nest" && subcommand === "start") {
      return NEST;
    }
  }
  return undefined;
}
