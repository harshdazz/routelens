import path from "node:path";
import * as vscode from "vscode";
import {
  findRouteDrafts,
  findServerDir,
  scanRoutes,
  syncRouteDrafts,
  type DetectedRoute,
  type ScanResult,
} from "@routelens/core";
import { hasRouteLensFolder } from "./environments";
import { scanSummary } from "./routeText";

/** workspaceState: project root → route keys RouteLens has seen there (ADR-0007). */
const KNOWN_ROUTES_KEY = "routelens.knownRoutes";
/** Wait this long after the last file change before scanning again. */
const RESCAN_DELAY_MS = 400;
const IGNORED_PATH =
  /[\\/](node_modules|\.next|\.git|dist|build|out|coverage|\.turbo|\.vscode-test)[\\/]/;

export interface ProjectRoutes {
  root: string;
  result: ScanResult;
  /** Route key → draft request file (absolute path). */
  drafts: Record<string, string>;
  /** Drafts whose route is no longer in the code. */
  orphaned: string[];
}

/** Where a route is: its project folder and its key (`POST /api/posts`). */
export interface RouteTarget {
  root: string;
  key: string;
}

/**
 * The routes of every workspace folder, read by core's scanner (M3). Scans after activation,
 * whenever a source or request file changes, and on demand. In trusted workspaces that are
 * set up (`.routelens/` exists) it also creates and updates the draft request of each route.
 */
export class RouteIndex implements vscode.Disposable {
  private readonly projects = new Map<string, ProjectRoutes>();
  private readonly queue = new Map<string, Promise<void>>();
  private readonly waiting = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    const sources = vscode.workspace.createFileSystemWatcher(
      "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
    );
    const requests = vscode.workspace.createFileSystemWatcher(
      "**/.routelens/requests/**/*.req.json",
    );
    for (const watcher of [sources, requests]) {
      this.disposables.push(
        watcher,
        watcher.onDidCreate((uri) => this.schedule(uri)),
        watcher.onDidChange((uri) => this.schedule(uri)),
        watcher.onDidDelete((uri) => this.schedule(uri)),
      );
    }
  }

  all(): ProjectRoutes[] {
    return [...this.projects.values()];
  }

  find(target: RouteTarget): { project: ProjectRoutes; route: DetectedRoute } | undefined {
    const project = this.projects.get(target.root);
    const route = project?.result.routes.find((item) => item.key === target.key);
    return project && route ? { project, route } : undefined;
  }

  /** Routes whose handler is in this file. */
  routesIn(uri: vscode.Uri): Array<{ project: ProjectRoutes; route: DetectedRoute }> {
    const wanted = uri.toString();
    return this.all().flatMap((project) =>
      project.result.routes
        .filter(
          (route) => vscode.Uri.file(path.join(project.root, route.file)).toString() === wanted,
        )
        .map((route) => ({ project, route })),
    );
  }

  /** Scan every workspace folder. */
  async refreshAll(): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    for (const root of this.projects.keys()) if (!roots.includes(root)) this.projects.delete(root);
    await Promise.all(roots.map((root) => this.refresh(root)));
  }

  /** Scan one folder. Scans of the same folder run one after another, never at once. */
  refresh(root: string): Promise<void> {
    const next = (this.queue.get(root) ?? Promise.resolve()).then(() => this.scan(root));
    this.queue.set(root, next);
    return next;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  private schedule(uri: vscode.Uri): void {
    if (IGNORED_PATH.test(uri.fsPath)) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    this.waiting.add(folder.uri.fsPath);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const roots = [...this.waiting];
      this.waiting.clear();
      for (const root of roots) void this.refresh(root);
    }, RESCAN_DELAY_MS);
  }

  private async scan(root: string): Promise<void> {
    try {
      const dir = await findServerDir(root).catch(() => undefined);
      if (!dir) {
        if (this.projects.delete(root)) this.changed.fire();
        return;
      }
      const started = Date.now();
      const result = await scanRoutes(dir, { root });
      const project: ProjectRoutes = { root, result, drafts: {}, orphaned: [] };

      if (await hasRouteLensFolder(root)) {
        if (vscode.workspace.isTrusted) {
          await this.syncDrafts(project);
        } else {
          project.drafts = await findRouteDrafts(root); // untrusted: read only
        }
      }
      this.projects.set(root, project);
      this.output.appendLine(
        `Routes: ${scanSummary(result.routes.length, result.frameworks)} ${result.filesScanned} files in ${Date.now() - started} ms (${path.basename(root)}).`,
      );
      for (const skipped of result.skipped) {
        this.output.appendLine(`  skipped ${skipped.file}:${skipped.line}: ${skipped.reason}`);
      }
      this.changed.fire();
    } catch (error) {
      this.output.appendLine(
        `✕ route scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async syncDrafts(project: ProjectRoutes): Promise<void> {
    const knownByRoot = this.context.workspaceState.get<Record<string, string[]>>(
      KNOWN_ROUTES_KEY,
      {},
    );
    const known = knownByRoot[project.root];
    const sync = await syncRouteDrafts(project.root, project.result.routes, {
      known,
      skip: (file) => isOpenWithChanges(file),
    });
    await this.context.workspaceState.update(KNOWN_ROUTES_KEY, {
      ...knownByRoot,
      [project.root]: sync.known,
    });
    project.drafts = sync.drafts;
    project.orphaned = sync.orphaned;

    for (const file of sync.created)
      this.output.appendLine(`  created ${path.relative(project.root, file)}`);
    for (const file of sync.updated)
      this.output.appendLine(`  updated ${path.relative(project.root, file)}`);
    if (known === undefined && sync.created.length > 0) {
      void vscode.window
        .showInformationMessage(
          `RouteLens: found ${sync.created.length === 1 ? "1 API route" : `${sync.created.length} API routes`} in your code and made a request for each.`,
          "Show routes",
        )
        .then((choice) => choice && vscode.commands.executeCommand("routelens.routes.focus"));
    }
  }
}

/** A draft open in an editor with unsaved changes: RouteLens leaves it alone for now. */
function isOpenWithChanges(file: string): boolean {
  const wanted = vscode.Uri.file(file).toString();
  return vscode.workspace.textDocuments.some(
    (document) => document.isDirty && document.uri.toString() === wanted,
  );
}
