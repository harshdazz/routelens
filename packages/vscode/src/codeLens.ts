import * as vscode from "vscode";
import { inlineResultTitle, inlineResultTooltip } from "./inlineResult";
import type { ResultStore } from "./results";

/** The button at the top of a file. */
export interface FileLens {
  title: string;
  tooltip: string;
  command: string;
}

const SEND_REQUEST: FileLens = {
  title: "$(play) Send request",
  tooltip: "Send this request with RouteLens",
  command: "routelens.sendRequest",
};

/** For `.flow.json` files (M4). */
export const RUN_FLOW: FileLens = {
  title: "$(play) Run flow",
  tooltip: "Run every step of this flow with RouteLens",
  command: "routelens.runFlow",
};

/**
 * Shows "▶ Send request" at the top of every `.req.json` file (or "▶ Run flow" on a
 * `.flow.json`), and next to it the last result (`✓ 201 Created · 14 ms`): hover for a
 * preview, click for the full panel.
 */
export class RequestCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly results: ResultStore,
    private readonly lens: FileLens = SEND_REQUEST,
  ) {
    this.subscription = results.onDidChange(() => this.changed.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [new vscode.CodeLens(top, { ...this.lens, arguments: [document.uri] })];
    const result = this.results.get(document.uri);
    if (result) {
      lenses.push(
        new vscode.CodeLens(top, {
          title: inlineResultTitle(result),
          tooltip: inlineResultTooltip(result),
          // While sending there is nothing to open yet.
          command: result.kind === "sending" ? "" : "routelens.showLastResponse",
          arguments: [document.uri],
        }),
      );
    }
    return lenses;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
