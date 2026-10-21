import path from "node:path";
import {
  DEFAULT_ENVIRONMENT,
  FLOWS_DIR,
  FLOW_FILE_SUFFIX,
  ROUTELENS_DIR,
  RouteLensError,
  describeClue,
  detectServer,
  draftRequest,
  findServerDir,
  listEnvironments,
  listFlowFiles,
  listRequestFiles,
  readEnvironment,
  readRequestFile,
  requestSchema,
  savedRequestName,
  scanRoutes,
  type ApiRequest,
  type DetectedRoute,
  type ScanResult,
  type Variables,
} from "@routelens/core";

/** A request the agent can run: a saved file, or a draft made in memory from a route. */
export interface RunItem {
  /** Saved request name (`create-post`), or the route key for an in-memory draft. */
  name: string;
  /** Absolute path, for saved requests. */
  file: string | undefined;
  request: ApiRequest;
  route: DetectedRoute | undefined;
}

export interface Broken {
  /** Relative to the project, with `/`. */
  file: string;
  problem: string;
}

export interface ProjectEnvironment {
  name: string;
  variables: Variables;
  /** Where the variables came from, for the agent: a file, or the detected address. */
  from: string;
}

/**
 * One project folder, read again on every tool call: the agent edits code and files while it
 * works, so nothing is cached here (the scanner has its own parse cache).
 */
export class Project {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Relative to the project, with `/`. */
  relative(file: string): string {
    return path.relative(this.root, file).split(path.sep).join("/");
  }

  /**
   * The environment's variables. Without an environment file, `local` falls back to the
   * address zero setup detects (ADR-0006), so a project without `.routelens/` still works.
   */
  async environment(name?: string): Promise<ProjectEnvironment> {
    const wanted = name ?? DEFAULT_ENVIRONMENT;
    const environment = await readEnvironment(this.root, wanted);
    if (environment) {
      return {
        name: wanted,
        variables: environment.variables,
        from: `${ROUTELENS_DIR}/environments/${wanted}.env.json`,
      };
    }
    if (wanted !== DEFAULT_ENVIRONMENT) {
      const names = await listEnvironments(this.root);
      throw new RouteLensError(
        "invalid-request",
        `No environment "${wanted}". Environments: ${names.length > 0 ? names.join(", ") : "none"}.`,
      );
    }
    const address = (await detectServer(this.root).catch(() => undefined))?.address;
    return address
      ? {
          name: wanted,
          variables: { baseUrl: address.baseUrl },
          from: `detected from ${describeClue(address)}`,
        }
      : {
          name: wanted,
          variables: {},
          from: "nothing: no environment file and no server address found",
        };
  }

  async scan(): Promise<ScanResult> {
    const dir = await findServerDir(this.root).catch(() => undefined);
    return dir
      ? scanRoutes(dir, { root: this.root })
      : { routes: [], skipped: [], frameworks: [], filesScanned: 0 };
  }

  /**
   * Everything "run all" runs: the saved requests, then a draft for each route that has no
   * saved request (made in memory, nothing is written). Broken files are reported.
   */
  async runItems(
    routes: readonly DetectedRoute[],
  ): Promise<{ items: RunItem[]; broken: Broken[] }> {
    const items: RunItem[] = [];
    const broken: Broken[] = [];
    for (const file of await listRequestFiles(this.root)) {
      try {
        const request = await readRequestFile(file);
        const route = routes.find((item) => item.key === request.route?.key);
        items.push({ name: savedRequestName(this.root, file), file, request, route });
      } catch (error) {
        broken.push({ file: this.relative(file), problem: messageOf(error) });
      }
    }
    const saved = new Set(items.map((item) => item.request.route?.key));
    for (const route of routes) {
      if (saved.has(route.key)) continue;
      items.push({
        name: route.key,
        file: undefined,
        request: requestSchema.parse(draftRequest(route)),
        route,
      });
    }
    return { items, broken };
  }

  /** Flow names (`create-and-read-post`) with their files. */
  async flows(): Promise<Array<{ name: string; file: string }>> {
    const dir = path.join(this.root, ROUTELENS_DIR, FLOWS_DIR);
    return (await listFlowFiles(this.root)).map((file) => ({
      name: path.relative(dir, file).split(path.sep).join("/").slice(0, -FLOW_FILE_SUFFIX.length),
      file,
    }));
  }

  /** The origins (`https://staging.example.com`) that appear in any environment file. */
  async environmentOrigins(): Promise<Set<string>> {
    const origins = new Set<string>();
    for (const name of await listEnvironments(this.root)) {
      const environment = await readEnvironment(this.root, name).catch(() => undefined);
      for (const value of Object.values(environment?.variables ?? {})) {
        try {
          const url = new URL(value);
          if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
        } catch {
          // not a URL
        }
      }
    }
    return origins;
  }

  /** The absolute path of a project file the scanner reported, or `undefined` if outside the root. */
  insideRoot(relative: string): string | undefined {
    const file = path.resolve(this.root, relative);
    return file.startsWith(this.root + path.sep) ? file : undefined;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
