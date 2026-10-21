import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readPackageJson } from "./packageJson.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageManagerInfo {
  name: PackageManager;
  /** Why: a lockfile name, `"packageManager" in package.json`, or "default" when nothing was found. */
  clue: string;
}

/** If one folder has several lockfiles, the first one in this list wins. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

/**
 * Find the package manager from `dir` upwards: Corepack's `packageManager` field first,
 * then a lockfile. A monorepo keeps its lockfile at the root, so a package folder looks up.
 *
 * The walk stops at `root` (the workspace folder), or at the Git repository root above it
 * when there is one. It never goes higher, so a stray lockfile in the home folder is ignored.
 */
export async function detectPackageManager(dir: string, root: string): Promise<PackageManagerInfo> {
  const boundary = (await findGitRoot(root)) ?? path.resolve(root);
  for (const current of ancestors(path.resolve(dir), boundary)) {
    const declared = await declaredPackageManager(current);
    if (declared) return { name: declared, clue: '"packageManager" in package.json' };

    let names: Set<string>;
    try {
      names = new Set(await readdir(current));
    } catch {
      continue;
    }
    const lockfile = LOCKFILES.find(([file]) => names.has(file));
    if (lockfile) return { name: lockfile[1], clue: lockfile[0] };
  }
  return { name: "npm", clue: "default" };
}

/** The command a user would type: `pnpm run dev`. Works the same for npm, pnpm, yarn and bun. */
export function runScriptCommand(packageManager: PackageManager, script: string): string {
  return `${packageManager} run ${script}`;
}

async function declaredPackageManager(dir: string): Promise<PackageManager | undefined> {
  let field: string | undefined;
  try {
    field = (await readPackageJson(dir))?.packageManager;
  } catch {
    return undefined;
  }
  const name = field?.split("@")[0];
  return PACKAGE_MANAGERS.find((manager) => manager === name);
}

/** `dir`, its parent, ... up to and including `boundary`. Just `dir` if it is outside `boundary`. */
function ancestors(dir: string, boundary: string): string[] {
  const relative = path.relative(boundary, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [dir];
  const list = [dir];
  let current = dir;
  while (current !== boundary) {
    const parent = path.dirname(current);
    if (parent === current) break;
    list.push(parent);
    current = parent;
  }
  return list;
}

async function findGitRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  for (;;) {
    try {
      await stat(path.join(current, ".git"));
      return current;
    } catch {
      // keep looking
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
