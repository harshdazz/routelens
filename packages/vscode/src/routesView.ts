import path from "node:path";
import * as vscode from "vscode";
import {
  FLOW_FILE_SUFFIX,
  REQUEST_FILE_SUFFIX,
  type DetectedRoute,
  type SkippedRoute,
} from "@routelens/core";
import { inlineResultTitle, resultPassed, type LastResult } from "./inlineResult";
import type { ResultStore } from "./results";
import type { ProjectRoutes, RouteIndex, RouteTarget } from "./routeIndex";
import { routeLabel, routeTooltip, skippedLabel, testSummaryText } from "./routeText";
import type { RunSummary, TestRunner } from "./testRunner";

export type RouteNode =
  | { kind: "project"; project: ProjectRoutes }
  | { kind: "summary"; project: ProjectRoutes; summary: RunSummary }
  | { kind: "route"; project: ProjectRoutes; route: DetectedRoute }
  | { kind: "requests"; project: ProjectRoutes }
  | { kind: "request"; project: ProjectRoutes; file: string }
  | { kind: "flows"; project: ProjectRoutes }
  | { kind: "flow"; project: ProjectRoutes; file: string }
  | { kind: "orphans"; project: ProjectRoutes }
  | { kind: "orphan"; project: ProjectRoutes; file: string }
  | { kind: "skips"; project: ProjectRoutes }
  | { kind: "skip"; project: ProjectRoutes; skipped: SkippedRoute };

/**
 * The Routes view (M3) and health board (M4): every route RouteLens found, with the last
 * result of its request, the last "Test everything" run, other saved requests and flows.
 * Requests whose route is gone and code RouteLens could not read are listed too, so nothing
 * disappears silently.
 */
export class RoutesTreeProvider implements vscode.TreeDataProvider<RouteNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<RouteNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly index: RouteIndex,
    private readonly results: ResultStore,
    private readonly runner: TestRunner,
  ) {
    this.subscriptions = [
      index.onDidChange(() => this.changed.fire(undefined)),
      results.onDidChange(() => this.changed.fire(undefined)),
      runner.onDidChange(() => this.changed.fire(undefined)),
    ];
  }

  /** "14 routes · 12 ✓ 2 ✗" for the view's title bar. */
  description(): string | undefined {
    const projects = this.index.all();
    const count = projects.reduce((sum, project) => sum + project.result.routes.length, 0);
    const parts = count === 0 ? [] : [count === 1 ? "1 route" : `${count} routes`];
    const summaries = projects.flatMap((project) => this.runner.summary(project.root) ?? []);
    if (summaries.length > 0) {
      const passed = summaries.reduce((sum, item) => sum + item.passed, 0);
      const failed = summaries.reduce((sum, item) => sum + item.failed, 0);
      parts.push(failed > 0 ? `${passed} ✓ ${failed} ✗` : `${passed} ✓`);
    }
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }

  getChildren(node?: RouteNode): RouteNode[] {
    if (!node) {
      const projects = this.index.all().filter((project) => hasContent(project));
      if (projects.length === 1 && projects[0]) return this.projectChildren(projects[0]);
      return projects.map((project) => ({ kind: "project", project }));
    }
    switch (node.kind) {
      case "project":
        return this.projectChildren(node.project);
      case "requests":
        return otherRequests(node.project).map((file) => ({
          kind: "request",
          project: node.project,
          file,
        }));
      case "flows":
        return node.project.flows.map((file) => ({ kind: "flow", project: node.project, file }));
      case "orphans":
        return node.project.orphaned.map((file) => ({
          kind: "orphan",
          project: node.project,
          file,
        }));
      case "skips":
        return node.project.result.skipped.map((skipped) => ({
          kind: "skip",
          project: node.project,
          skipped,
        }));
      default:
        return [];
    }
  }

  getTreeItem(node: RouteNode): vscode.TreeItem {
    switch (node.kind) {
      case "project": {
        const item = new vscode.TreeItem(
          path.basename(node.project.root),
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon("root-folder");
        return item;
      }
      case "summary": {
        const { summary } = node;
        const item = new vscode.TreeItem(
          testSummaryText(summary.passed, summary.failed, summary.durationMs),
        );
        const time = new Date(summary.finishedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        item.description = summary.cancelled ? `cancelled · ${time}` : time;
        item.tooltip = "The last Test everything run. Run it again from the view's title bar.";
        item.iconPath =
          summary.failed > 0
            ? new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"))
            : new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
        return item;
      }
      case "route":
        return this.routeItem(node.project, node.route);
      case "requests": {
        const item = new vscode.TreeItem("Requests", vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(otherRequests(node.project).length);
        item.tooltip = "Saved requests that are not made from a route in your code.";
        item.iconPath = new vscode.ThemeIcon("files");
        return item;
      }
      case "request":
        return this.fileItem(node.file, REQUEST_FILE_SUFFIX, "request");
      case "flows": {
        const item = new vscode.TreeItem("Flows", vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(node.project.flows.length);
        item.tooltip =
          "Flows (.flow.json): requests run in order, with checks. Plain code replays them.";
        item.iconPath = new vscode.ThemeIcon("list-ordered");
        return item;
      }
      case "flow":
        return this.fileItem(node.file, FLOW_FILE_SUFFIX, "flow");
      case "orphans": {
        const item = new vscode.TreeItem(
          "No longer in the code",
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = String(node.project.orphaned.length);
        item.tooltip =
          "Requests made from routes RouteLens no longer finds. They are kept; delete them if you don't need them.";
        item.iconPath = new vscode.ThemeIcon("warning");
        return item;
      }
      case "orphan": {
        const item = new vscode.TreeItem(path.basename(node.file));
        item.resourceUri = vscode.Uri.file(node.file);
        item.command = {
          title: "Open request",
          command: "vscode.open",
          arguments: [vscode.Uri.file(node.file)],
        };
        return item;
      }
      case "skips": {
        const item = new vscode.TreeItem(
          "Could not read",
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = String(node.project.result.skipped.length);
        item.tooltip = "Code that looks like a route, but RouteLens could not tell its path.";
        item.iconPath = new vscode.ThemeIcon("question");
        return item;
      }
      case "skip": {
        const item = new vscode.TreeItem(skippedLabel(node.skipped));
        item.description = node.skipped.reason;
        item.tooltip = `${skippedLabel(node.skipped)}: ${node.skipped.reason}`;
        item.command = openAt(node.project.root, node.skipped.file, node.skipped.line);
        return item;
      }
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }

  private projectChildren(project: ProjectRoutes): RouteNode[] {
    const summary = this.runner.summary(project.root);
    const children: RouteNode[] = summary ? [{ kind: "summary", project, summary }] : [];
    for (const route of project.result.routes) children.push({ kind: "route", project, route });
    if (otherRequests(project).length > 0) children.push({ kind: "requests", project });
    if (project.flows.length > 0) children.push({ kind: "flows", project });
    if (project.orphaned.length > 0) children.push({ kind: "orphans", project });
    if (project.result.skipped.length > 0) children.push({ kind: "skips", project });
    return children;
  }

  private routeItem(project: ProjectRoutes, route: DetectedRoute): vscode.TreeItem {
    const item = new vscode.TreeItem(routeLabel(route));
    const draft = project.drafts[route.key];
    const result = draft ? this.results.get(vscode.Uri.file(draft)) : undefined;
    item.id = `${project.root}\0${route.key}`;
    item.description = result ? resultText(result) : `${route.file}:${route.line}`;
    item.tooltip = routeTooltip(route, draft && path.relative(project.root, draft));
    item.iconPath = resultIcon(result);
    item.contextValue = "route";
    item.command = openAt(project.root, route.file, route.line);
    return item;
  }

  /** A request or flow file, with its last result. */
  private fileItem(file: string, suffix: string, contextValue: string): vscode.TreeItem {
    const uri = vscode.Uri.file(file);
    const item = new vscode.TreeItem(path.basename(file, suffix));
    const result = this.results.get(uri);
    item.id = file;
    item.resourceUri = uri;
    item.description = result ? resultText(result) : undefined;
    item.iconPath = resultIcon(result);
    item.contextValue = contextValue;
    item.command = { title: "Open", command: "vscode.open", arguments: [uri] };
    return item;
  }
}

/** Commands on a request or flow in the view get a node; from an editor they get a URI. */
export function fileUriOf(argument: unknown): vscode.Uri | undefined {
  if (argument instanceof vscode.Uri) return argument;
  const node = argument as Partial<{ file: string }> | undefined;
  return typeof node?.file === "string" ? vscode.Uri.file(node.file) : undefined;
}

/** Saved requests that are neither route drafts nor drafts whose route is gone. */
function otherRequests(project: ProjectRoutes): string[] {
  const linked = new Set([...Object.values(project.drafts), ...project.orphaned]);
  return project.requests.filter((file) => !linked.has(file));
}

/** Commands from the view and the CodeLens get a node or a target; both mean one route. */
export function routeTargetOf(argument: unknown): RouteTarget | undefined {
  const value = argument as Partial<RouteNode & RouteTarget> | undefined;
  if (value?.kind === "route" && value.project && value.route) {
    return { root: value.project.root, key: value.route.key };
  }
  if (typeof value?.root === "string" && typeof value.key === "string")
    return { root: value.root, key: value.key };
  return undefined;
}

function hasContent(project: ProjectRoutes): boolean {
  return (
    project.result.routes.length > 0 ||
    project.requests.length > 0 ||
    project.flows.length > 0 ||
    project.orphaned.length > 0 ||
    project.result.skipped.length > 0
  );
}

function resultText(result: LastResult): string {
  return result.kind === "sending" ? "sending..." : inlineResultTitle(result);
}

function resultIcon(result: LastResult | undefined): vscode.ThemeIcon {
  if (!result) return new vscode.ThemeIcon("circle-large-outline");
  if (result.kind === "sending") return new vscode.ThemeIcon("sync~spin");
  return resultPassed(result)
    ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
    : new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
}

function openAt(root: string, file: string, line: number): vscode.Command {
  const position = new vscode.Position(Math.max(0, line - 1), 0);
  return {
    title: "Go to code",
    command: "vscode.open",
    arguments: [
      vscode.Uri.file(path.join(root, file)),
      { selection: new vscode.Range(position, position) },
    ],
  };
}
