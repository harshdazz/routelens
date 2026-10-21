import { readdir } from "node:fs/promises";
import path from "node:path";
import { HTTP_METHODS } from "../model.js";
import { dependencyNames, readPackageJson } from "../detect/packageJson.js";
import { scanExpress } from "./express.js";
import { nextBasePath, scanNextApp, scanNextPages } from "./next.js";
import { SourceProject } from "./project.js";
import type { DetectedRoute, RouteFramework, ScanResult, SkippedRoute } from "./routes.js";
import { loadTypeScript } from "./ts.js";

/** Folders that never hold route handlers (dependencies, build output, caches). */
const IGNORED_FOLDERS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".output",
  ".cache",
  ".routelens",
  ".vscode-test",
  "dist",
  "build",
  "out",
  "coverage",
]);
const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s)$/;

export interface ScanOptions {
  /** Paths in the result are relative to this folder (default: the scanned folder). */
  root?: string;
  /** Stop listing files after this many (default 5000), so huge folders stay fast. */
  maxFiles?: number;
}

/**
 * Find the API routes in a project folder by reading its code, never running it (ADR-0007).
 * Frameworks come from package.json: `next` → App Router and Pages API, `express` → Express.
 */
export async function scanRoutes(dir: string, options: ScanOptions = {}): Promise<ScanResult> {
  const folder = path.resolve(dir);
  const pkg = await readPackageJson(folder).catch(() => undefined);
  const dependencies = new Set(pkg ? dependencyNames(pkg) : []);
  const frameworks: RouteFramework[] = [];
  if (dependencies.has("next")) frameworks.push("next-app", "next-pages");
  if (dependencies.has("express")) frameworks.push("express");
  if (frameworks.length === 0) return { routes: [], skipped: [], frameworks, filesScanned: 0 };

  // Only projects with a framework we read pay for loading the parser (~0.3 s, once).
  await loadTypeScript();
  const files = await listSourceFiles(folder, options.maxFiles ?? 5000);
  const project = SourceProject.open(folder, options.root ?? folder);
  const skipped: SkippedRoute[] = [];
  const found: DetectedRoute[] = [];

  if (dependencies.has("next")) {
    const basePath = await nextBasePath(project, folder);
    found.push(...(await scanNextApp(project, folder, files, basePath)));
    found.push(...(await scanNextPages(project, folder, files, basePath)));
  }
  if (dependencies.has("express")) {
    found.push(...(await scanExpress(project, files, skipped)));
  }

  return { routes: sortRoutes(dedupe(found)), skipped, frameworks, filesScanned: files.length };
}

/** Source files under `dir`, skipping dependencies and build output. Absolute paths, sorted. */
export async function listSourceFiles(dir: string, maxFiles = 5000): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (!IGNORED_FOLDERS.has(entry.name)) await walk(path.join(current, entry.name));
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(path.join(current, entry.name));
      }
    }
  };
  await walk(dir);
  return files;
}

/** The first route wins when two have the same method and path. */
function dedupe(routes: DetectedRoute[]): DetectedRoute[] {
  const seen = new Set<string>();
  return routes.filter((route) => !seen.has(route.key) && seen.add(route.key));
}

/** By path, then in the usual method order (GET, POST, PUT, PATCH, DELETE…). */
export function sortRoutes(routes: DetectedRoute[]): DetectedRoute[] {
  const order = (method: string): number =>
    HTTP_METHODS.indexOf(method as (typeof HTTP_METHODS)[number]);
  return [...routes].sort(
    (a, b) => a.path.localeCompare(b.path) || order(a.method) - order(b.method),
  );
}
