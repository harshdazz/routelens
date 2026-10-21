import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { LastResult } from "./inlineResult";
import {
  renderErrorHtml,
  renderFlowHtml,
  renderResponseHtml,
  type ErrorView,
  type FlowView,
  type ResponseView,
} from "./responseHtml";

/** One reusable panel beside the editor that shows the latest response. */
export class ResponsePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private closedByUser = false;

  showResponse(view: ResponseView): void {
    const panel = this.reveal(`${view.response.status} · ${view.requestName}`);
    panel.webview.html = renderResponseHtml(view, nonce());
  }

  showError(view: ErrorView): void {
    const panel = this.reveal(`Failed · ${view.requestName}`);
    panel.webview.html = renderErrorHtml(view, nonce());
  }

  showFlow(view: FlowView): void {
    const panel = this.reveal(`${view.run.passed ? "Passed" : "Failed"} · ${view.flowName}`);
    panel.webview.html = renderFlowHtml(view, nonce());
  }

  /** Show a result and bring the panel back (a click on the inline result). */
  show(result: LastResult): void {
    this.closedByUser = false;
    if (result.kind === "response") this.showResponse(result.view);
    if (result.kind === "error") this.showError(result.view);
    if (result.kind === "flow") this.showFlow(result.view);
  }

  /**
   * After a send: show the result, unless the user closed the panel. Then the inline result
   * next to "▶ Send request" is enough, and RouteLens does not keep popping the panel open.
   */
  update(result: LastResult): void {
    if (!this.closedByUser) this.show(result);
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private reveal(title: string): vscode.WebviewPanel {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "routelens.response",
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        // Static HTML only: no scripts, no local files.
        { enableScripts: false, localResourceRoots: [] },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.closedByUser = true;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }
    this.panel.title = title;
    return this.panel;
  }
}

function nonce(): string {
  return randomBytes(16).toString("base64");
}
