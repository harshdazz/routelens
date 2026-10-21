import * as vscode from "vscode";
import { RequestCodeLensProvider } from "./codeLens";
import { newRequestCommand } from "./commands/newRequest";
import { sendRequestCommand } from "./commands/sendRequest";
import { Environments, currentProjectRoot, hasRouteLensFolder } from "./environments";
import { ResponsePanel } from "./responsePanel";
import { ResultStore } from "./results";
import { ServerManager } from "./serverManager";
import {
  autoSetUp,
  changeServerAddress,
  openFirstRequest,
  setUpProject,
  type SetupDeps,
} from "./setup";

/**
 * Runs in any folder with a package.json, so it must stay cheap (ADR-0006): register things
 * here, and do the small amount of file reading (detection) after activation, without blocking.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("RouteLens");
  const panel = new ResponsePanel();
  const results = new ResultStore();
  const environments = new Environments(context);
  const server = new ServerManager(context, output);
  const codeLens = new RequestCodeLensProvider(results);

  const refreshProjectState = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const ready = (await Promise.all(folders.map((f) => hasRouteLensFolder(f.uri.fsPath)))).some(
      Boolean,
    );
    // Ticks the "Find your API" walkthrough step and shows the status bar item.
    await vscode.commands.executeCommand("setContext", "routelens.projectReady", ready);
    await environments.refresh();
  };
  const setup: SetupDeps = {
    context,
    output,
    onProjectChanged: () => void refreshProjectState(),
  };
  /** Zero setup for every folder, then update the status bar and walkthrough. */
  const startUp = async (): Promise<void> => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        await autoSetUp(folder, setup);
      } catch (error) {
        output.appendLine(
          `✕ setup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await refreshProjectState();
  };

  context.subscriptions.push(
    output,
    panel,
    results,
    environments,
    server,
    codeLens,
    vscode.commands.registerCommand("routelens.sendRequest", (uri?: vscode.Uri) =>
      sendRequestCommand({ uri, panel, output, results, server, environments }),
    ),
    vscode.commands.registerCommand("routelens.newRequest", () => newRequestCommand(setup)),
    vscode.commands.registerCommand("routelens.showLastResponse", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const result = target && results.get(target);
      if (result) panel.show(result);
    }),
    vscode.commands.registerCommand("routelens.selectEnvironment", () => environments.select()),
    vscode.commands.registerCommand("routelens.setUpProject", async () => {
      const root = await pickFolder();
      if (root) await setUpProject(root, setup);
    }),
    vscode.commands.registerCommand("routelens.changeServerAddress", async () => {
      const root = (await currentProjectRoot()) ?? (await pickFolder());
      return root ? changeServerAddress(root, setup) : undefined;
    }),
    vscode.commands.registerCommand("routelens.openFirstRequest", async () => {
      const root = (await currentProjectRoot()) ?? (await pickFolder());
      if (!root) return;
      if (!(await openFirstRequest(root))) await setUpProject(root, setup);
    }),
    vscode.commands.registerCommand("routelens.startServer", async () =>
      server.startCommand((await currentProjectRoot()) ?? (await pickFolder())),
    ),
    vscode.commands.registerCommand("routelens.stopServer", async () => {
      const stopped = await server.stopAll();
      if (stopped === 0) {
        void vscode.window.showInformationMessage(
          "RouteLens: no server started by RouteLens is running.",
        );
      }
      return stopped;
    }),
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", pattern: "**/*.req.json" },
      codeLens,
    ),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void startUp()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void startUp()),
  );
  void startUp();
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

/** The only workspace folder, or ask when there are several. */
async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    if (!folders[0]) void vscode.window.showInformationMessage("RouteLens: open a folder first.");
    return folders[0]?.uri.fsPath;
  }
  return (await vscode.window.showWorkspaceFolderPick({ placeHolder: "Which project?" }))?.uri
    .fsPath;
}
