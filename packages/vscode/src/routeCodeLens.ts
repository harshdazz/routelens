import path from "node:path";
import * as vscode from "vscode";
import { inlineResultTitle, inlineResultTooltip } from "./inlineResult";
import type { ResultStore } from "./results";
import type { RouteIndex, RouteTarget } from "./routeIndex";
import { routeLensTitle, routeTooltip } from "./routeText";

/** Source files that can hold route handlers. */
export const ROUTE_SOURCE_SELECTOR: vscode.DocumentSelector = [
  { scheme: "file", language: "typescript" },
  { scheme: "file", language: "javascript" },
  { scheme: "file", language: "typescriptreact" },
  { scheme: "file", language: "javascriptreact" },
];

/**
 * "▶ Send POST /api/posts" above each route handler RouteLens found (M3), and next to it
 * the last result of that route's request (`✓ 201 Created · 14 ms`).
 */
export class RouteCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly index: RouteIndex,
    private readonly results: ResultStore,
  ) {
    this.subscriptions = [
      index.onDidChange(() => this.changed.fire()),
      results.onDidChange(() => this.changed.fire()),
    ];
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const { project, route } of this.index.routesIn(document.uri)) {
      const line = Math.max(0, Math.min(route.line - 1, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const draft = project.drafts[route.key];
      const target: RouteTarget = { root: project.root, key: route.key };
      lenses.push(
        new vscode.CodeLens(range, {
          title: routeLensTitle(route),
          tooltip: routeTooltip(route, draft && path.relative(project.root, draft)),
          command: "routelens.sendRoute",
          arguments: [target],
        }),
      );
      const result = draft ? this.results.get(vscode.Uri.file(draft)) : undefined;
      if (draft && result) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: inlineResultTitle(result),
            tooltip: inlineResultTooltip(result),
            command: result.kind === "sending" ? "" : "routelens.showLastResponse",
            arguments: [vscode.Uri.file(draft)],
          }),
        );
      }
    }
    return lenses;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
