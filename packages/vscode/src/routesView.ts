import path from "node:path";
import * as vscode from "vscode";
import type { DetectedRoute, SkippedRoute } from "@routelens/core";
import { inlineResultTitle, type LastResult } from "./inlineResult";
import type { ResultStore } from "./results";
import type { ProjectRoutes, RouteIndex, RouteTarget } from "./routeIndex";
import { routeLabel, routeTooltip, skippedLabel } from "./routeText";

export type RouteNode =
  | { kind: "project"; project: ProjectRoutes }
  | { kind: "route"; project: ProjectRoutes; route: DetectedRoute }
  | { kind: "orphans"; project: ProjectRoutes }
  | { kind: "orphan"; project: ProjectRoutes; file: string }
  | { kind: "skips"; project: ProjectRoutes }
  | { kind: "skip"; project: ProjectRoutes; skipped: SkippedRoute };

/**
 * The Routes view (M3): every route RouteLens found, with the last result of its request.
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
  ) {
    this.subscriptions = [
      index.onDidChange(() => this.changed.fire(undefined)),
      results.onDidChange(() => this.changed.fire(undefined)),
    ];
  }

  /** "14 routes" for the view's title bar. */
  description(): string | undefined {
    const count = this.index.all().reduce((sum, project) => sum + project.result.routes.length, 0);
    return count === 0 ? undefined : count === 1 ? "1 route" : `${count} routes`;
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
      case "route":
        return this.routeItem(node.project, node.route);
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
    const children: RouteNode[] = project.result.routes.map((route) => ({
      kind: "route",
      project,
      route,
    }));
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
  const passed = result.kind === "response" && result.view.response.status < 400;
  return passed
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
