import { readdir } from "node:fs/promises";
import path from "node:path";
import { dependencyNames, readTextIfExists, type PackageJson } from "./packageJson.js";
import { pickStartScript } from "./scripts.js";

/**
 * Folders of the packages in a monorepo, from `workspaces` in package.json (npm, yarn, bun)
 * or `pnpm-workspace.yaml`. Empty when `root` is not a monorepo.
 * Supports exact folders (`apps/api`) and one-level globs (`apps/*`); other globs are skipped.
 */
export async function listWorkspacePackages(
  root: string,
  rootPackage: PackageJson,
): Promise<string[]> {
  const patterns = [
    ...(Array.isArray(rootPackage.workspaces)
      ? rootPackage.workspaces
      : (rootPackage.workspaces?.packages ?? [])),
    ...parsePnpmWorkspace((await readTextIfExists(path.join(root, "pnpm-workspace.yaml"))) ?? ""),
  ];

  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    const clean = pattern.replace(/\/+$/, "").replace(/^\.\//, "");
    const glob = /^(.*?)\/\*\*?$/.exec(clean);
    if (glob) {
      const parent = path.join(root, glob[1] ?? "");
      for (const name of await subfolders(parent)) dirs.add(path.join(parent, name));
    } else if (!clean.includes("*")) {
      dirs.add(path.join(root, clean));
    }
  }

  const packages: string[] = [];
  for (const dir of [...dirs].sort()) {
    if ((await readTextIfExists(path.join(dir, "package.json"))) !== undefined) packages.push(dir);
  }
  return packages;
}

/** The `packages:` list of a pnpm-workspace.yaml (block or `[a, b]` style). */
export function parsePnpmWorkspace(text: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    const inline = /^packages\s*:\s*\[(.*)\]/.exec(line);
    if (inline) {
      patterns.push(...(inline[1] ?? "").split(",").map(unquote).filter(Boolean));
      inPackages = false;
      continue;
    }
    if (/^packages\s*:\s*(#.*)?$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (item?.[1]) patterns.push(unquote(item[1]));
    else if (/^\S/.test(line)) inPackages = false;
  }
  return patterns;
}

/** Packages that are almost always an API server. */
const SERVER_DEPENDENCIES = [
  "express",
  "fastify",
  "koa",
  "hono",
  "@nestjs/core",
  "@hapi/hapi",
  "elysia",
];
/** Full-stack frameworks that can have API routes. */
const FULL_STACK_DEPENDENCIES = ["next", "nuxt", "@remix-run/node", "@sveltejs/kit"];
const SERVER_FOLDER_NAMES = ["api", "server", "backend"];

/**
 * How likely a package is to be the project's API server; higher is better.
 * 0 means it has no `dev`/`start` script, so RouteLens could not start it anyway.
 */
export function serverScore(pkg: PackageJson, dir: string): number {
  if (!pickStartScript(pkg.scripts)) return 0;
  const dependencies = dependencyNames(pkg);
  let score = 1;
  if (dependencies.some((name) => SERVER_DEPENDENCIES.includes(name))) score += 3;
  else if (dependencies.some((name) => FULL_STACK_DEPENDENCIES.includes(name))) score += 2;
  const names = [path.basename(dir), pkg.name?.split("/").pop() ?? ""];
  if (names.some((name) => SERVER_FOLDER_NAMES.includes(name.toLowerCase()))) score += 1;
  return score;
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}
