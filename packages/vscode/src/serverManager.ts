import path from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_ENVIRONMENT,
  RouteLensError,
  detectServer,
  isPortOpen,
  localServerOf,
  readEnvironment,
  waitForPort,
  type ServerDetection,
  type StartCommand,
} from "@routelens/core";
import { startDecision } from "./serverPolicy";

/** What happened when RouteLens tried to make the server answer. */
export type StartOutcome =
  | "started"
  | "already-running"
  /** The process exited before the port opened (reported to the user). */
  | "crashed"
  /** The port did not open within 60 s (reported to the user). */
  | "timeout"
  | "cancelled"
  /** The user said no to "Start server". */
  | "declined"
  /** RouteLens may not or cannot start it: setting is "never", untrusted, or no dev/start script. */
  | "unavailable";

export interface Target {
  host: string;
  port: number;
}

const APPROVED_KEY = "routelens.serverStartApproved";
const TASK_TYPE = "routelens";
const TASK_NAME = "dev server";
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const START_BUTTON = "▶ Start server";
const ALWAYS_BUTTON = "Always start";

interface RunningServer {
  execution: vscode.TaskExecution;
  start: StartCommand;
  /** Set when RouteLens stops it on purpose, so the exit is not reported as a crash. */
  stopping: boolean;
  /** True while RouteLens waits for the port to open. */
  waiting: boolean;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | undefined>;
  markExited: (exitCode: number | undefined) => void;
}

/**
 * Starts the user's dev server in a visible terminal (a VS Code task) and waits for its port.
 * A task tells us when the process exits and with which code, so crashes can be reported;
 * text typed into a plain terminal could not.
 */
export class ServerManager implements vscode.Disposable {
  /** Servers RouteLens started, by folder. */
  private readonly running = new Map<string, RunningServer>();
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.disposables = [vscode.tasks.onDidEndTaskProcess((event) => this.handleExit(event))];
  }

  /**
   * Called by Send when nothing answers on `target`. Asks first, or starts right away when
   * `routelens.autoStartServer` is "always" and the user already clicked Start once here.
   */
  async ensureRunning(root: string, target: Target): Promise<StartOutcome> {
    if (!vscode.workspace.isTrusted) return "unavailable";
    const setting = vscode.workspace.getConfiguration("routelens").get<string>("autoStartServer");
    const decision = startDecision(setting, this.approved());
    if (decision === "skip") return "unavailable";

    const start = (await this.detect(root))?.start;
    if (!start) return "unavailable";

    // A server RouteLens already started may still be booting: just wait for it.
    if (decision === "ask" && !this.active(start.cwd)) {
      const choice = await vscode.window.showInformationMessage(
        `RouteLens: nothing is running on ${target.host}:${target.port}. ` +
          `Start your server with "${start.command}"${describeFolder(root, start.cwd)}?`,
        START_BUTTON,
        ALWAYS_BUTTON,
      );
      if (!choice) return "declined";
      await this.approve();
      if (choice === ALWAYS_BUTTON) {
        await vscode.workspace
          .getConfiguration("routelens")
          .update("autoStartServer", "always", vscode.ConfigurationTarget.Global);
      }
    }
    return this.startAndWait(start, target);
  }

  /** "RouteLens: Start Server". Running the command counts as the user's click. */
  async startCommand(root: string | undefined): Promise<StartOutcome> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        "RouteLens: trust this workspace to start your server.",
      );
      return "unavailable";
    }
    if (!root) {
      void vscode.window.showInformationMessage(
        "RouteLens: open a folder with a package.json first.",
      );
      return "unavailable";
    }
    const detection = await this.detect(root);
    if (!detection?.start) {
      void vscode.window.showWarningMessage(
        'RouteLens: there is no "dev" or "start" script in package.json, so there is nothing to start.',
      );
      return "unavailable";
    }
    // Wait for the address requests use (local.env.json), else the detected one.
    const baseUrl =
      (await readEnvironment(root, DEFAULT_ENVIRONMENT).catch(() => undefined))?.variables
        .baseUrl ?? detection.address?.baseUrl;
    const target = baseUrl ? localServerOf(baseUrl) : undefined;
    await this.approve();
    if (!target) {
      await this.launch(detection.start);
      return "started";
    }
    return this.startAndWait(detection.start, target);
  }

  /** "RouteLens: Stop Server": stop the servers RouteLens started and wait until they exit. */
  async stopAll(): Promise<number> {
    const servers = [...this.running.values()].filter((server) => !server.stopping);
    for (const server of servers) {
      server.stopping = true;
      server.execution.terminate();
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS));
    await Promise.race([Promise.all(servers.map((server) => server.exited)), timeout]);
    return servers.length;
  }

  showTerminal(): void {
    const terminal = vscode.window.terminals.find((t) => t.name.includes(TASK_NAME));
    if (terminal) terminal.show();
    else void vscode.commands.executeCommand("workbench.action.terminal.focus");
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async startAndWait(start: StartCommand, target: Target): Promise<StartOutcome> {
    if (await isPortOpen(target.port, { host: target.host })) return "already-running";
    const server = this.active(start.cwd) ?? (await this.launch(start));
    server.waiting = true;

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `RouteLens: starting your server (${start.command})`,
        cancellable: true,
      },
      async (progress, token): Promise<StartOutcome> => {
        progress.report({ message: `waiting for port ${target.port}...` });
        const controller = new AbortController();
        const cancel = token.onCancellationRequested(() => controller.abort("cancelled"));
        // Stop waiting as soon as the process exits, even if it exited before we got here.
        void server.exited.then((exitCode) => controller.abort({ exitCode }));
        try {
          await waitForPort(target.port, {
            host: target.host,
            timeoutMs: START_TIMEOUT_MS,
            signal: controller.signal,
          });
          this.output.appendLine(`✓ server is up on port ${target.port}`);
          return "started";
        } catch (error) {
          if (error instanceof RouteLensError && error.code === "timeout") {
            void this.reportTimeout(target);
            return "timeout";
          }
          return controller.signal.reason === "cancelled" ? "cancelled" : "crashed";
        } finally {
          server.waiting = false;
          cancel.dispose();
        }
      },
    );
  }

  private async launch(start: StartCommand): Promise<RunningServer> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(start.cwd));
    const task = new vscode.Task(
      { type: TASK_TYPE, script: start.script, cwd: start.cwd },
      folder ?? vscode.TaskScope.Workspace,
      TASK_NAME,
      "RouteLens",
      // Only the dev/start script found in package.json, never a command from a .routelens file.
      new vscode.ShellExecution(start.command, {
        cwd: start.cwd,
        // On Windows, PowerShell would pick npm.ps1, which the default execution policy blocks.
        // cmd.exe runs npm.cmd, the same way npm runs scripts itself.
        ...(process.platform === "win32" ? { executable: "cmd.exe", shellArgs: ["/d", "/c"] } : {}),
      }),
      [],
    );
    task.isBackground = true;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      focus: false,
      clear: true,
      echo: true,
    };
    this.output.appendLine(`▶ ${start.command} (in ${start.cwd})`);
    const execution = await vscode.tasks.executeTask(task);

    let markExited: (exitCode: number | undefined) => void = () => undefined;
    const exited = new Promise<number | undefined>((resolve) => (markExited = resolve));
    const server: RunningServer = {
      execution,
      start,
      stopping: false,
      waiting: false,
      exited,
      markExited,
    };
    this.running.set(start.cwd, server);
    return server;
  }

  private handleExit(event: vscode.TaskProcessEndEvent): void {
    // VS Code hands out one TaskExecution object per run, so this finds exactly our run.
    const server = [...this.running.values()].find((s) => s.execution === event.execution);
    if (!server) return;
    if (this.running.get(server.start.cwd) === server) this.running.delete(server.start.cwd);
    server.markExited(event.exitCode);

    const code = event.exitCode === undefined ? "" : ` (exit code ${event.exitCode})`;
    this.output.appendLine(`■ ${server.start.command} stopped${code}`);
    if (server.stopping) return;

    const message = server.waiting
      ? `RouteLens: your server stopped before it was ready${code}. The terminal shows why.`
      : `RouteLens: your server stopped${code}.`;
    void vscode.window.showErrorMessage(message, "Show terminal").then((choice) => {
      if (choice) this.showTerminal();
    });
  }

  private async reportTimeout(target: Target): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `RouteLens: nothing answered on port ${target.port} after ${START_TIMEOUT_MS / 1000} s. ` +
        "Is your server using a different port?",
      "Show terminal",
      "Change address",
    );
    if (choice === "Show terminal") this.showTerminal();
    if (choice === "Change address") {
      await vscode.commands.executeCommand("routelens.changeServerAddress");
    }
  }

  /** A server RouteLens started in `cwd` that is not being stopped. */
  private active(cwd: string): RunningServer | undefined {
    const server = this.running.get(cwd);
    return server && !server.stopping ? server : undefined;
  }

  private async detect(root: string): Promise<ServerDetection | undefined> {
    try {
      return await detectServer(root);
    } catch (error) {
      this.output.appendLine(`✕ ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private approved(): boolean {
    return this.context.workspaceState.get<boolean>(APPROVED_KEY, false);
  }

  private async approve(): Promise<void> {
    await this.context.workspaceState.update(APPROVED_KEY, true);
  }
}

function describeFolder(root: string, cwd: string): string {
  const relative = path.relative(root, cwd);
  return relative ? ` in ${relative.split(path.sep).join("/")}` : "";
}
