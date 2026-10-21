import { stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_ENVIRONMENT,
  ROUTELENS_DIR,
  environmentFilePath,
  findProjectRoot,
  listEnvironments,
  readEnvironment,
} from "@routelens/core";

const PICKED_KEY = "routelens.pickedEnvironment";

/**
 * Which environment requests use, and the status bar item that switches it.
 *
 * The `routelens.environment` setting is the default. Picking one in the status bar is saved
 * in VS Code's workspace state (not in your repo), and changing the setting clears that pick.
 */
export class Environments implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(
      "routelens.environment",
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.item.name = "RouteLens Environment";
    this.item.command = "routelens.selectEnvironment";

    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/${ROUTELENS_DIR}/environments/*.env.json`,
    );
    const refresh = (): void => void this.refresh();
    this.disposables.push(
      this.item,
      watcher,
      watcher.onDidCreate(refresh),
      watcher.onDidDelete(refresh),
      watcher.onDidChange(refresh),
      vscode.window.onDidChangeActiveTextEditor(refresh),
      vscode.workspace.onDidChangeWorkspaceFolders(refresh),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("routelens.environment")) {
          void this.context.workspaceState.update(PICKED_KEY, undefined).then(refresh);
        }
      }),
    );
  }

  /** The environment name to use for requests. */
  activeName(): string {
    return (
      this.context.workspaceState.get<string>(PICKED_KEY) ??
      vscode.workspace.getConfiguration("routelens").get<string>("environment", DEFAULT_ENVIRONMENT)
    );
  }

  /** Status bar quick pick: list `.routelens/environments/*.env.json`. */
  async select(): Promise<string | undefined> {
    const root = await currentProjectRoot();
    if (!root) {
      void vscode.window.showInformationMessage(
        'RouteLens: no .routelens folder yet. Run "RouteLens: Set Up Project" first.',
      );
      return undefined;
    }
    const active = this.activeName();
    const names = await listEnvironments(root);
    const items: Array<vscode.QuickPickItem & { name?: string }> = await Promise.all(
      names.map(async (name) => ({
        name,
        label: name === active ? `$(check) ${name}` : name,
        description: (await readEnvironment(root, name).catch(() => undefined))?.variables.baseUrl,
      })),
    );
    items.push({ label: "$(go-to-file) Open the active environment file" });

    const picked = await vscode.window.showQuickPick(items, {
      title: "RouteLens environment",
      placeHolder:
        names.length > 0 ? "Which environment should requests use?" : "No environments yet",
    });
    if (!picked) return undefined;
    if (!picked.name) {
      const document = await vscode.workspace.openTextDocument(environmentFilePath(root, active));
      await vscode.window.showTextDocument(document);
      return undefined;
    }
    await this.context.workspaceState.update(PICKED_KEY, picked.name);
    await this.refresh();
    return picked.name;
  }

  /** Show the status bar item only in projects that have a `.routelens` folder. */
  async refresh(): Promise<void> {
    const root = await currentProjectRoot();
    if (!root) {
      this.item.hide();
      return;
    }
    const name = this.activeName();
    const environment = await readEnvironment(root, name).catch(() => undefined);
    this.item.text = `$(server-environment) ${name}`;
    this.item.tooltip = environment
      ? `RouteLens environment "${name}"${environment.variables.baseUrl ? `: ${environment.variables.baseUrl}` : ""}. Click to switch.`
      : `RouteLens environment "${name}" (no ${name}.env.json yet). Click to switch.`;
    this.item.show();
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

/** The project of the active file, else the first workspace folder that has `.routelens/`. */
export async function currentProjectRoot(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    const root = await findProjectRoot(path.dirname(active.fsPath));
    if (root) return root;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await hasRouteLensFolder(folder.uri.fsPath)) return folder.uri.fsPath;
  }
  return undefined;
}

export async function hasRouteLensFolder(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, ROUTELENS_DIR))).isDirectory();
  } catch {
    return false;
  }
}
