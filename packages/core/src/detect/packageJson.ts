import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseJsonFile } from "../model.js";

const stringMap = z.record(z.string(), z.string());

/** The parts of a `package.json` that detection reads. Other fields are allowed and ignored. */
export const packageJsonSchema = z.looseObject({
  name: z.string().optional(),
  main: z.string().optional(),
  scripts: stringMap.optional(),
  dependencies: stringMap.optional(),
  devDependencies: stringMap.optional(),
  /** Corepack's field, e.g. "pnpm@10.16.1". */
  packageManager: z.string().optional(),
  /** npm, yarn and bun monorepos: `["apps/*"]` or `{ "packages": ["apps/*"] }`. */
  workspaces: z
    .union([z.array(z.string()), z.looseObject({ packages: z.array(z.string()).optional() })])
    .optional(),
});

export type PackageJson = z.output<typeof packageJsonSchema>;

/** Reads `<dir>/package.json`. Returns `undefined` if there is none; throws if it is invalid. */
export async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  const filePath = path.join(dir, "package.json");
  const text = await readTextIfExists(filePath);
  if (text === undefined) return undefined;
  return parseJsonFile(packageJsonSchema, text, filePath);
}

/** All dependency names, runtime and dev. */
export function dependencyNames(pkg: PackageJson): string[] {
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

/** File text, or `undefined` when the file does not exist. Other errors are thrown. */
export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
    throw error;
  }
}
