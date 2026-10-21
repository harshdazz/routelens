import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { RouteLensError } from "./errors.js";
import {
  parseEnvironment,
  parseFlow,
  parseRequest,
  type ApiRequest,
  type ApiRequestInput,
  type Environment,
  type EnvironmentInput,
  type Flow,
} from "./model.js";

/** Folder in the user's project that holds everything RouteLens saves (see ADR-0003). */
export const ROUTELENS_DIR = ".routelens";
export const REQUESTS_DIR = "requests";
export const ENVIRONMENTS_DIR = "environments";
export const FLOWS_DIR = "flows";
export const REQUEST_FILE_SUFFIX = ".req.json";
export const ENVIRONMENT_FILE_SUFFIX = ".env.json";
export const FLOW_FILE_SUFFIX = ".flow.json";

export async function readRequestFile(filePath: string): Promise<ApiRequest> {
  return parseRequest(await readText(filePath), path.basename(filePath));
}

/** Stable, readable JSON so diffs in pull requests stay small. */
export function serializeRequest(request: ApiRequestInput): string {
  const ordered = {
    version: request.version,
    name: request.name,
    ...(request.description === undefined ? {} : { description: request.description }),
    method: request.method,
    url: request.url,
    headers: request.headers ?? {},
    query: request.query ?? {},
    body: request.body ?? { type: "none" },
    ...(request.expect === undefined ? {} : { expect: request.expect }),
    ...(request.route === undefined
      ? {}
      : {
          route: {
            key: request.route.key,
            ...(request.route.file === undefined ? {} : { file: request.route.file }),
            // Sorted, so the file only changes when a fingerprint does.
            generated: Object.fromEntries(
              Object.entries(request.route.generated ?? {}).sort(([a], [b]) => a.localeCompare(b)),
            ),
          },
        }),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writeRequestFile(filePath: string, request: ApiRequestInput): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeRequest(request), "utf8");
}

/** Absolute paths of all `.req.json` files under `<root>/.routelens/requests`, sorted. */
export function listRequestFiles(root: string): Promise<string[]> {
  return listFiles(path.join(root, ROUTELENS_DIR, REQUESTS_DIR), REQUEST_FILE_SUFFIX);
}

/** Absolute paths of all `.flow.json` files under `<root>/.routelens/flows`, sorted. */
export function listFlowFiles(root: string): Promise<string[]> {
  return listFiles(path.join(root, ROUTELENS_DIR, FLOWS_DIR), FLOW_FILE_SUFFIX);
}

export async function readFlowFile(filePath: string): Promise<Flow> {
  return parseFlow(await readText(filePath), path.basename(filePath));
}

/**
 * The file of a saved request named in a flow step: `"create-post"` or `"auth/login"` →
 * `<root>/.routelens/requests/create-post.req.json`. `undefined` when the name would leave
 * the requests folder.
 */
export function savedRequestPath(root: string, name: string): string | undefined {
  const dir = path.resolve(root, ROUTELENS_DIR, REQUESTS_DIR);
  const file = path.resolve(dir, `${name}${REQUEST_FILE_SUFFIX}`);
  return file.startsWith(dir + path.sep) ? file : undefined;
}

/** The name a flow step uses for a saved request: its path in the requests folder. */
export function savedRequestName(root: string, filePath: string): string {
  const relative = path.relative(path.join(root, ROUTELENS_DIR, REQUESTS_DIR), filePath);
  return relative.split(path.sep).join("/").slice(0, -REQUEST_FILE_SUFFIX.length);
}

async function listFiles(folder: string, suffix: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(fullPath);
      }
    }
  };
  await walk(folder);
  return files.sort();
}

/** Reads `<root>/.routelens/environments/<name>.env.json`. Returns `undefined` if it does not exist. */
export async function readEnvironment(
  root: string,
  name: string,
): Promise<Environment | undefined> {
  const filePath = environmentFilePath(root, name);
  try {
    return parseEnvironment(await readFile(filePath, "utf8"), path.basename(filePath));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** `<root>/.routelens/environments/<name>.env.json` */
export function environmentFilePath(root: string, name: string): string {
  return path.join(root, ROUTELENS_DIR, ENVIRONMENTS_DIR, `${name}${ENVIRONMENT_FILE_SUFFIX}`);
}

/** Names of all environments (file names without `.env.json`), sorted. */
export async function listEnvironments(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(root, ROUTELENS_DIR, ENVIRONMENTS_DIR));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(ENVIRONMENT_FILE_SUFFIX))
    .map((name) => name.slice(0, -ENVIRONMENT_FILE_SUFFIX.length))
    .sort();
}

export function serializeEnvironment(environment: EnvironmentInput): string {
  const ordered = {
    version: environment.version,
    name: environment.name,
    variables: environment.variables ?? {},
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Writes `<root>/.routelens/environments/<name>.env.json` and returns its path. */
export async function writeEnvironmentFile(
  root: string,
  environment: EnvironmentInput,
): Promise<string> {
  const filePath = environmentFilePath(root, environment.name);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeEnvironment(environment), "utf8");
  return filePath;
}

/** Set some variables of an environment, creating the file if needed. Other variables are kept. */
export async function setEnvironmentVariables(
  root: string,
  name: string,
  variables: Record<string, string>,
): Promise<Environment> {
  const current = await readEnvironment(root, name);
  const environment: Environment = {
    version: 1,
    name,
    variables: { ...current?.variables, ...variables },
  };
  await writeEnvironmentFile(root, environment);
  return environment;
}

/** The environment RouteLens creates and uses by default. */
export const DEFAULT_ENVIRONMENT = "local";

/**
 * A typed base URL, cleaned up: must be http(s); no trailing slash, so `{{baseUrl}}/api`
 * does not become `//api`. Returns `undefined` if it is not a valid URL.
 */
export function normalizeBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.toString().replace(/\/+$/, "");
}

export interface CreatedProjectFiles {
  /** Set when `local.env.json` was created. */
  environmentFile: string | undefined;
  /** Set when the first request was created. */
  requestFile: string | undefined;
}

/**
 * Zero setup (ADR-0006): create `.routelens/environments/local.env.json` with `baseUrl`,
 * and a first request (`GET {{baseUrl}}/`) when there are no requests yet.
 * Existing files are never overwritten.
 */
export async function createProjectFiles(
  root: string,
  baseUrl: string,
): Promise<CreatedProjectFiles> {
  const created: CreatedProjectFiles = { environmentFile: undefined, requestFile: undefined };

  if (!(await readEnvironment(root, DEFAULT_ENVIRONMENT))) {
    created.environmentFile = await writeEnvironmentFile(root, {
      version: 1,
      name: DEFAULT_ENVIRONMENT,
      variables: { baseUrl },
    });
  }

  if ((await listRequestFiles(root)).length === 0) {
    const filePath = requestFilePath(root, "First request");
    await writeRequestFile(filePath, {
      version: 1,
      name: "First request",
      description: "Created by RouteLens. Change the path, or add more requests next to this file.",
      method: "GET",
      url: "{{baseUrl}}/",
    });
    created.requestFile = filePath;
  }
  return created;
}

/** Walk up from `startDir` to find the folder that contains `.routelens/`. */
export async function findProjectRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  for (;;) {
    if (await isDirectory(path.join(current, ROUTELENS_DIR))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** Where a new request named `name` is saved: `<root>/.routelens/requests/<slug>.req.json`. */
export function requestFilePath(root: string, name: string): string {
  return path.join(root, ROUTELENS_DIR, REQUESTS_DIR, `${slugify(name)}${REQUEST_FILE_SUFFIX}`);
}

/** "Create Post (v2)!" → "create-post-v2". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "request";
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new RouteLensError("invalid-file", `Could not read ${filePath}.`, { cause: error });
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
