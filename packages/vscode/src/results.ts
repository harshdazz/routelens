import * as vscode from "vscode";
import type { LastResult } from "./inlineResult";

/** The last result of each request file, shown inline by the CodeLens. Kept in memory only. */
export class ResultStore implements vscode.Disposable {
  private readonly results = new Map<string, LastResult>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  get(uri: vscode.Uri): LastResult | undefined {
    return this.results.get(uri.toString());
  }

  set(uri: vscode.Uri, result: LastResult): void {
    this.results.set(uri.toString(), result);
    this.changed.fire();
  }

  delete(uri: vscode.Uri): void {
    if (this.results.delete(uri.toString())) this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
