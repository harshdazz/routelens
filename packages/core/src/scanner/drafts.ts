import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import type { ApiRequest, ApiRequestInput, RequestBody } from "../model.js";
import {
  REQUEST_FILE_SUFFIX,
  listRequestFiles,
  readRequestFile,
  requestFilePath,
  serializeRequest,
  writeRequestFile,
} from "../storage.js";
import { findServerDir } from "../detect/detect.js";
import { routeParams, samplePath } from "./paths.js";
import type { DetectedRoute } from "./routes.js";
import { scanRoutes } from "./scan.js";

/**
 * Draft requests: one `.req.json` per detected route, kept up to date as the code changes
 * (ADR-0007). RouteLens stores a short fingerprint of every value it writes. On the next
 * scan it replaces a value only while the value still matches its fingerprint, so anything
 * the user edited is kept.
 */

/** Short, stable fingerprint of a value RouteLens wrote. */
export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex")
    .slice(0, 8);
}

/** The request RouteLens makes for a route: its method, a sendable URL and a sample body. */
export function draftRequest(route: DetectedRoute): ApiRequestInput {
  const name = route.key;
  const url = `{{baseUrl}}${samplePath(route.path)}`;
  const body = draftBody(route);
  return {
    version: 1,
    name,
    method: route.method,
    url,
    body,
    route: { key: route.key, file: route.file, generated: fingerprints(name, url, body) },
  };
}

/**
 * Bring a draft up to date with its route. Values whose fingerprint still matches are
 * replaced; edited values are kept. For JSON object bodies this works key by key: new
 * keys from the schema are added, removed keys are dropped, and keys the user added,
 * changed or deleted stay that way. Returns `undefined` when nothing changes.
 */
export function updateDraft(
  existing: ApiRequest,
  route: DetectedRoute,
): ApiRequestInput | undefined {
  const fresh = draftRequest(route);
  const freshPrints = fresh.route?.generated ?? {};
  const oldPrints = existing.route?.generated ?? {};
  const prints: Record<string, string> = {};
  const next: ApiRequestInput = { ...existing };

  for (const field of ["name", "url"] as const) {
    const print = oldPrints[field];
    if (print === fingerprint(existing[field])) {
      next[field] = fresh[field];
      prints[field] = freshPrints[field] ?? "";
    } else if (print !== undefined) {
      prints[field] = print;
    }
  }

  const freshBody = fresh.body ?? { type: "none" };
  const oldContent = jsonObject(existing.body);
  const freshContent = jsonObject(freshBody);
  if (oldContent && freshContent) {
    const content: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(oldContent)) {
      const print = oldPrints[`body/${key}`];
      if (print === undefined) {
        content[key] = value; // added by the user
      } else if (print !== fingerprint(value)) {
        content[key] = value; // edited by the user
        prints[`body/${key}`] = print;
      } else if (key in freshContent) {
        content[key] = freshContent[key];
        prints[`body/${key}`] = freshPrints[`body/${key}`] ?? "";
      } // else: RouteLens wrote it and the schema dropped it
    }
    for (const [key, value] of Object.entries(freshContent)) {
      if (key in oldContent) continue;
      const print = oldPrints[`body/${key}`];
      if (print !== undefined) {
        prints[`body/${key}`] = print; // deleted by the user: keep it deleted
      } else {
        content[key] = value;
        prints[`body/${key}`] = freshPrints[`body/${key}`] ?? "";
      }
    }
    next.body = { type: "json", content };
  } else if (bodyUnedited(existing.body, oldPrints)) {
    next.body = freshBody;
    for (const [key, print] of Object.entries(freshPrints)) {
      if (key === "body" || key.startsWith("body/")) prints[key] = print;
    }
  } else {
    for (const [key, print] of Object.entries(oldPrints)) {
      if (key === "body" || key.startsWith("body/")) prints[key] = print;
    }
  }

  next.route = { key: route.key, file: route.file, generated: prints };
  return serializeRequest(next) === serializeRequest(existing) ? undefined : next;
}

export interface DraftSyncOptions {
  /**
   * Route keys RouteLens has seen before in this workspace. Drafts are only created for
   * routes not in this list, so a draft the user deleted does not come back by itself.
   * Leave it out to create a draft for every route without one.
   */
  known?: readonly string[];
  /** Files not to touch now, e.g. drafts open with unsaved changes. */
  skip?: (file: string) => boolean;
}

export interface DraftSyncResult {
  created: string[];
  updated: string[];
  /** Drafts whose route is no longer in the code. They are kept, never deleted. */
  orphaned: string[];
  /** Route key → draft file, for every route that has a draft now. */
  drafts: Record<string, string>;
  /** `known` plus every route seen now: pass it back on the next sync. */
  known: string[];
}

/**
 * Create drafts for new routes, update the drafts of changed routes and follow renames:
 * when one route disappears from a file and one route with the same method appears in
 * that file, the draft moves to the new route.
 */
export async function syncRouteDrafts(
  root: string,
  routes: readonly DetectedRoute[],
  options: DraftSyncOptions = {},
): Promise<DraftSyncResult> {
  const linked = await readLinkedDrafts(root);
  const detected = new Set(routes.map((route) => route.key));
  const result: DraftSyncResult = { created: [], updated: [], orphaned: [], drafts: {}, known: [] };

  // Renames: a vanished route and a new route with the same method in the same file.
  const unclaimed = routes.filter((route) => !linked.has(route.key));
  const vanished = [...linked.entries()].filter(([key]) => !detected.has(key));
  for (const [key, draft] of vanished) {
    const sameSpot = (method: string, file: string | undefined): boolean =>
      method === draft.request.method && file === draft.request.route?.file;
    const candidates = unclaimed.filter((route) => sameSpot(route.method, route.file));
    const rivals = vanished.filter(([, other]) =>
      sameSpot(other.request.method, other.request.route?.file),
    );
    const [target] = candidates;
    if (target && candidates.length === 1 && rivals.length === 1) {
      linked.delete(key);
      linked.set(target.key, draft);
      unclaimed.splice(unclaimed.indexOf(target), 1);
    }
  }

  const known = new Set(options.known ?? []);
  for (const route of routes) {
    const draft = linked.get(route.key);
    if (draft) {
      result.drafts[route.key] = draft.file;
      if (options.skip?.(draft.file)) continue;
      const updated = updateDraft(draft.request, route);
      if (updated) {
        await writeRequestFile(draft.file, updated);
        result.updated.push(draft.file);
      }
    } else if (options.known === undefined || !known.has(route.key)) {
      const file = await createRouteDraft(root, route);
      result.drafts[route.key] = file;
      result.created.push(file);
    }
  }

  for (const [key, draft] of linked) {
    if (!detected.has(key)) result.orphaned.push(draft.file);
  }
  result.known = [...new Set([...known, ...detected])].sort();
  return result;
}

/** Write a new draft for a route, next to the other requests, without overwriting a file. */
export async function createRouteDraft(root: string, route: DetectedRoute): Promise<string> {
  const base = requestFilePath(root, route.key).slice(0, -REQUEST_FILE_SUFFIX.length);
  let file = `${base}${REQUEST_FILE_SUFFIX}`;
  for (let index = 2; await exists(file); index += 1)
    file = `${base}-${index}${REQUEST_FILE_SUFFIX}`;
  await writeRequestFile(file, draftRequest(route));
  return file;
}

/** Route key → draft file, for every request linked to a route. Reads only; writes nothing. */
export async function findRouteDrafts(root: string): Promise<Record<string, string>> {
  const drafts: Record<string, string> = {};
  for (const [key, draft] of await readLinkedDrafts(root)) drafts[key] = draft.file;
  return drafts;
}

/** Route key → draft, for every valid request file that is linked to a route. */
async function readLinkedDrafts(
  root: string,
): Promise<Map<string, { file: string; request: ApiRequest }>> {
  const linked = new Map<string, { file: string; request: ApiRequest }>();
  for (const file of await listRequestFiles(root)) {
    let request: ApiRequest;
    try {
      request = await readRequestFile(file);
    } catch {
      continue; // A broken file is the user's to fix; never overwrite it.
    }
    const key = request.route?.key;
    if (key !== undefined && !linked.has(key))
      linked.set(key, { file: path.resolve(file), request });
  }
  return linked;
}

function draftBody(route: DetectedRoute): RequestBody {
  if (route.body) return { type: "json", content: route.body.sample };
  if (route.method === "POST" || route.method === "PUT" || route.method === "PATCH") {
    return { type: "json", content: {} };
  }
  return { type: "none" };
}

/** `name`, `url`, and the body: per top-level key for a JSON object, else as a whole. */
function fingerprints(name: string, url: string, body: RequestBody): Record<string, string> {
  const prints: Record<string, string> = { name: fingerprint(name), url: fingerprint(url) };
  const content = jsonObject(body);
  if (content) {
    for (const [key, value] of Object.entries(content)) prints[`body/${key}`] = fingerprint(value);
  } else {
    prints.body = fingerprint(body);
  }
  return prints;
}

/** True when RouteLens wrote this body and nobody changed it since. */
function bodyUnedited(body: RequestBody, prints: Record<string, string>): boolean {
  const content = jsonObject(body);
  if (!content) return prints.body === fingerprint(body);
  const keyPrints = Object.keys(prints).filter((key) => key.startsWith("body/"));
  return (
    keyPrints.length === Object.keys(content).length &&
    Object.entries(content).every(([key, value]) => prints[`body/${key}`] === fingerprint(value))
  );
}

function jsonObject(body: RequestBody): Record<string, unknown> | undefined {
  if (body.type !== "json") return undefined;
  const content = body.content;
  return typeof content === "object" && content !== null && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Health checks answer without data or a login: the safest first request to try. */
const HEALTH_PATH = /\/(health|healthz|healthcheck)$/i;
const STATUS_PATH = /\/(status|ping|ready|readyz|live|livez)$/i;

/**
 * The route for a project's first request: a GET route, a health check first, then a status
 * or ping route, then one without parameters (nothing to guess, so it should answer), then
 * the shortest path. `undefined` when the project has no GET route.
 */
export function pickFirstRoute(routes: readonly DetectedRoute[]): DetectedRoute | undefined {
  const rank = (route: DetectedRoute): number => {
    if (HEALTH_PATH.test(route.path)) return 0;
    if (STATUS_PATH.test(route.path)) return 1;
    return routeParams(route.path).length === 0 && !route.path.includes("{") ? 2 : 3;
  };
  return routes
    .filter((route) => route.method === "GET")
    .map((route, index) => ({ route, index }))
    .sort(
      (a, b) =>
        rank(a.route) - rank(b.route) ||
        a.route.path.length - b.route.path.length ||
        a.index - b.index,
    )[0]?.route;
}

/**
 * Zero setup's first request when the code has a GET route: that route's draft, so it
 * answers, follows the route when the code changes, and is not made a second time.
 * `undefined` when RouteLens finds no GET route (zero setup then uses `GET /`).
 */
export async function projectFirstRequest(root: string): Promise<ApiRequestInput | undefined> {
  const dir = await findServerDir(root).catch(() => undefined);
  if (!dir) return undefined;
  const route = pickFirstRoute((await scanRoutes(dir, { root })).routes);
  if (!route) return undefined;
  return {
    ...draftRequest(route),
    description: `Created by RouteLens from ${route.key} in ${route.file}. It follows that route when your code changes. Add more requests next to this file.`,
  };
}
