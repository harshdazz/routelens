import path from "node:path";
import * as vscode from "vscode";
import { RUN_FLOW, RequestCodeLensProvider } from "./codeLens";
import { newRequestCommand } from "./commands/newRequest";
import { openRouteRequestCommand, scanRoutesCommand, sendRouteCommand } from "./commands/routes";
import { sendRequestCommand } from "./commands/sendRequest";
import { Environments, currentProjectRoot, hasRouteLensFolder } from "./environments";
import { Logins } from "./logins";
import { ResponsePanel } from "./responsePanel";
import { ResultStore } from "./results";
import { ROUTE_SOURCE_SELECTOR, RouteCodeLensProvider } from "./routeCodeLens";
import { RouteIndex } from "./routeIndex";
import { RoutesTreeProvider, fileUriOf, routeTargetOf } from "./routesView";
import { ServerManager } from "./serverManager";
import {
  autoSetUp,
  changeServerAddress,
  openFirstRequest,
  setUpProject,
  type SetupDeps,
} from "./setup";
import { TestRunner } from "./testRunner";

/**
 * Runs in any folder with a package.json, so it must stay cheap (ADR-0006): register things
 * here, and do the file reading (detection, then route scanning) after activation, without
 * blocking. The TypeScript parser used by the scanner is only loaded by the first scan.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("RouteLens");
  const panel = new ResponsePanel();
  const results = new ResultStore();
  const environments = new Environments(context);
  const server = new ServerManager(context, output);
  const codeLens = new RequestCodeLensProvider(results);
  const flowLens = new RequestCodeLensProvider(results, RUN_FLOW);
  const logins = new Logins(context);
  const routes = new RouteIndex(context, output);
  const routeLens = new RouteCodeLensProvider(routes, results);

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
    onProjectChanged: () => {
      void refreshProjectState();
      void routes.refreshAll();
    },
  };
  const routeDeps = { index: routes, setup };
  const runner = new TestRunner({
    index: routes,
    results,
    server,
    environments,
    logins,
    panel,
    output,
    setup,
  });
  const routesTree = new RoutesTreeProvider(routes, results, runner);
  const routesView = vscode.window.createTreeView("routelens.routes", {
    treeDataProvider: routesTree,
    showCollapseAll: true,
  });
  const updateViewDescription = (): void => {
    routesView.description = routesTree.description();
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
    await routes.refreshAll();
  };

  context.subscriptions.push(
    output,
    panel,
    results,
    environments,
    server,
    codeLens,
    flowLens,
    logins,
    routes,
    routeLens,
    runner,
    routesTree,
    routesView,
    routes.onDidChange(updateViewDescription),
    runner.onDidChange(updateViewDescription),
    vscode.commands.registerCommand("routelens.testEverything", () => runner.testEverything()),
    vscode.commands.registerCommand("routelens.runFlow", (target?: unknown) =>
      runner.runFlowFile(fileUriOf(target)),
    ),
    vscode.commands.registerCommand("routelens.logOut", async () => {
      const count = await logins.logOut();
      void vscode.window.showInformationMessage(
        count > 0
          ? "RouteLens: logged out. The next 401 asks for your login again."
          : "RouteLens: there was no login to forget.",
      );
    }),
    vscode.commands.registerCommand("routelens.sendRoute", (target?: unknown) =>
      sendRouteCommand(routeTargetOf(target), routeDeps),
    ),
    vscode.commands.registerCommand("routelens.openRouteRequest", (target?: unknown) =>
      openRouteRequestCommand(routeTargetOf(target), routeDeps),
    ),
    vscode.commands.registerCommand("routelens.openRouteSource", async (target?: unknown) => {
      const found = routeTargetOf(target);
      const route = found && routes.find(found);
      if (!route) return;
      const line = Math.max(0, route.route.line - 1);
      await vscode.window.showTextDocument(
        vscode.Uri.file(path.join(route.project.root, route.route.file)),
        { selection: new vscode.Range(line, 0, line, 0) },
      );
    }),
    vscode.commands.registerCommand("routelens.scanRoutes", (options?: { quiet?: boolean }) =>
      scanRoutesCommand(routeDeps, !options?.quiet),
    ),
    vscode.commands.registerCommand("routelens.sendRequest", (target?: unknown) =>
      sendRequestCommand({
        uri: fileUriOf(target),
        panel,
        output,
        results,
        server,
        environments,
        logins,
      }),
    ),
    vscode.commands.registerCommand("routelens.newRequest", () => newRequestCommand(setup)),
    vscode.commands.registerCommand("routelens.showLastResponse", (argument?: unknown) => {
      const target = fileUriOf(argument) ?? vscode.window.activeTextEditor?.document.uri;
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
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", pattern: "**/*.flow.json" },
      flowLens,
    ),
    vscode.languages.registerCodeLensProvider(ROUTE_SOURCE_SELECTOR, routeLens),
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
