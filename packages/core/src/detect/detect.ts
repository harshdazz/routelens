import path from "node:path";
import { isPortOpen as checkPort } from "../ports.js";
import { findPortInCode } from "./code.js";
import { readEnvPort } from "./env.js";
import { readPackageJson, type PackageJson } from "./packageJson.js";
import { detectPackageManager, runScriptCommand, type PackageManager } from "./packageManager.js";
import { parseScript, pickStartScript, type StartScriptName } from "./scripts.js";
import { listWorkspacePackages, serverScore } from "./workspaces.js";

/** Where a guessed port came from. File paths are relative to the project root, with `/`. */
export type AddressClue =
  /** `next dev -p 3001`, `PORT=3001 node server.js` */
  | { kind: "script-port"; file: string; script: StartScriptName; command: string }
  /** `PORT=4100` in `.env.local` or `.env` */
  | { kind: "env-file"; file: string }
  /** `next dev` → Next.js listens on 3000 by default */
  | { kind: "tool-default"; file: string; script: StartScriptName; command: string; tool: string }
  /** `app.listen(4000)` */
  | { kind: "code"; file: string; line: number };

export interface AddressCandidate {
  /** e.g. `http://localhost:3000` (no trailing slash, so `{{baseUrl}}/api` works). */
  baseUrl: string;
  port: number;
  clue: AddressClue;
  /** True when something already answers on this port. */
  running: boolean;
}

export interface StartCommand {
  packageManager: PackageManager;
  /** Why this package manager: a lockfile name, `"packageManager" in package.json` or "default". */
  packageManagerClue: string;
  script: StartScriptName;
  /** What runs in the terminal, e.g. `pnpm run dev`. */
  command: string;
  /** Folder to run it in (a workspace package in a monorepo). */
  cwd: string;
}

export interface ServerDetection {
  /** The package that holds the server: `root` itself, or a workspace package in a monorepo. */
  serverDir: string;
  /** Best guess; `undefined` when no clue was found, so the user should be asked. */
  address: AddressCandidate | undefined;
  /** Every distinct port found, best first. Offered by the "Change" button. */
  candidates: AddressCandidate[];
  /** How to start the server; `undefined` when package.json has no `dev` or `start` script. */
  start: StartCommand | undefined;
}

export interface DetectOptions {
  /** Injected in tests; defaults to a ~300 ms TCP connect to localhost. */
  isPortOpen?: (port: number) => Promise<boolean>;
}

/**
 * Find a project's API server with plain code (ADR-0006): which package it lives in,
 * which address it uses and how to start it. Reads a handful of files; runs nothing.
 * Returns `undefined` when `root` has no package.json.
 *
 * Clues, best first:
 * 1. a port from the clues below that is already open (the server is running)
 * 2. a port written in the `dev`/`start` script (`-p 3001`): flags beat config files
 * 3. `PORT=` in `.env.local` / `.env`
 * 4. the default port of the tool in the script (`next dev` → 3000)
 * 5. `listen(4000)` in the server's entry file
 *
 * Next.js and Vite pick their port before reading `.env`, so for them 3 drops below 4.
 */
export async function detectServer(
  root: string,
  options: DetectOptions = {},
): Promise<ServerDetection | undefined> {
  const rootPackage = await readPackageJson(root);
  if (!rootPackage) return undefined;

  const { dir: serverDir, pkg } = await findServerPackage(root, rootPackage);
  const relative = (file: string): string =>
    path.relative(root, path.join(serverDir, file)).split(path.sep).join("/");

  const script = pickStartScript(pkg.scripts);
  const scriptInfo = script ? parseScript(script.command) : undefined;
  const clues: Array<{ port: number; clue: AddressClue }> = [];

  if (script && scriptInfo?.explicitPort !== undefined) {
    clues.push({
      port: scriptInfo.explicitPort,
      clue: {
        kind: "script-port",
        file: relative("package.json"),
        script: script.name,
        command: script.command,
      },
    });
  }

  const envPort = await readEnvPort(serverDir);
  const envClue = envPort && {
    port: envPort.port,
    clue: { kind: "env-file", file: relative(envPort.file) } as const,
  };
  const tool = scriptInfo?.tool;
  if (envClue && tool?.readsDotenvPort !== false) clues.push(envClue);

  if (script && tool) {
    clues.push({
      port: tool.defaultPort,
      clue: {
        kind: "tool-default",
        file: relative("package.json"),
        script: script.name,
        command: script.command,
        tool: tool.label,
      },
    });
  }
  if (envClue && tool?.readsDotenvPort === false) clues.push(envClue);

  const entryFiles = [...(scriptInfo?.entryFiles ?? []), ...(pkg.main ? [pkg.main] : [])];
  const codePort = await findPortInCode(serverDir, entryFiles);
  if (codePort) {
    clues.push({
      port: codePort.port,
      clue: { kind: "code", file: relative(codePort.file), line: codePort.line },
    });
  }

  // One candidate per port, keeping the best clue for it.
  const unique = clues.filter(
    (item, index) => clues.findIndex((other) => other.port === item.port) === index,
  );
  const isOpen = options.isPortOpen ?? ((port: number) => checkPort(port));
  const running = await Promise.all(unique.map((item) => isOpen(item.port)));
  const candidates = unique
    .map((item, index) => ({
      baseUrl: `http://localhost:${item.port}`,
      port: item.port,
      clue: item.clue,
      running: running[index] ?? false,
    }))
    // A running server is the strongest clue; otherwise keep the order above (sort is stable).
    .sort((a, b) => Number(b.running) - Number(a.running));

  let start: StartCommand | undefined;
  if (script) {
    const packageManager = await detectPackageManager(serverDir, root);
    start = {
      packageManager: packageManager.name,
      packageManagerClue: packageManager.clue,
      script: script.name,
      command: runScriptCommand(packageManager.name, script.name),
      cwd: serverDir,
    };
  }

  return { serverDir, address: candidates[0], candidates, start };
}

/** "`next dev -p 3001`" in package.json · PORT in .env · listen() in server.js:11 */
export function describeClue(candidate: AddressCandidate): string {
  const { clue } = candidate;
  let text: string;
  switch (clue.kind) {
    case "script-port":
      text = `"${shorten(clue.command)}" in ${clue.file}`;
      break;
    case "env-file":
      text = `PORT in ${clue.file}`;
      break;
    case "tool-default":
      text = `"${shorten(clue.command)}" in ${clue.file}: ${clue.tool} uses port ${candidate.port}`;
      break;
    case "code":
      text = `listen() in ${clue.file}:${clue.line}`;
      break;
  }
  return candidate.running ? `${text}, running now` : text;
}

/**
 * In a monorepo, the workspace package that looks most like an API server
 * (see `serverScore`). Otherwise, or when no package can be started, the root itself.
 */
async function findServerPackage(
  root: string,
  rootPackage: PackageJson,
): Promise<{ dir: string; pkg: PackageJson }> {
  let best: { dir: string; pkg: PackageJson; score: number } | undefined;
  for (const dir of await listWorkspacePackages(root, rootPackage)) {
    let pkg: PackageJson | undefined;
    try {
      pkg = await readPackageJson(dir);
    } catch {
      continue; // One broken package should not stop detection.
    }
    if (!pkg) continue;
    const score = serverScore(pkg, dir);
    if (score > 0 && (!best || score > best.score)) best = { dir, pkg, score };
  }
  return best ?? { dir: root, pkg: rootPackage };
}

function shorten(command: string): string {
  return command.length > 60 ? `${command.slice(0, 57)}...` : command;
}
