import { access } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  FLOW_FILE_SUFFIX,
  RouteLensError,
  createRouteDraft,
  findProjectRoot,
  isPortOpen,
  listFlowFiles,
  listRequestFiles,
  localServerOf,
  orderForRun,
  parseFlow,
  readEnvironment,
  readFlowFile,
  readRequestFile,
  resolveRequest,
  runFlow,
  runRequest,
  waitForPort,
  type ApiRequest,
  type AuthSession,
  type Flow,
  type FlowRun,
  type RequestRun,
  type SendOptions,
  type Variables,
} from "@routelens/core";
import type { Environments } from "./environments";
import { runLine, runToResult, stepProblem, type LastResult } from "./inlineResult";
import type { Logins } from "./logins";
import type { ResponsePanel } from "./responsePanel";
import type { ResultStore } from "./results";
import type { RouteIndex } from "./routeIndex";
import { testSummaryText } from "./routeText";
import type { ServerManager } from "./serverManager";
import { ensureLocalEnvironment, type SetupDeps } from "./setup";

/** The last "Test everything" run of one project: the health board. */
export interface RunSummary {
  root: string;
  passed: number;
  failed: number;
  durationMs: number;
  finishedAt: number;
  /** True when the person cancelled the run before the end. */
  cancelled: boolean;
}

export interface TestRunnerDeps {
  index: RouteIndex;
  results: ResultStore;
  server: ServerManager;
  environments: Environments;
  logins: Logins;
  panel: ResponsePanel;
  output: vscode.OutputChannel;
  setup: SetupDeps;
}

/** How long watch mode waits for a dev server that restarts after a save. */
const RESTART_WAIT_MS = 5_000;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SOURCE_FILE = /\.(m?[jt]sx?|c[jt]s)$/;

/** One project's run settings: environment, variables, timeout and login. */
interface ProjectRun {
  root: string;
  environmentName: string;
  /** Set when the environment file exists. */
  shownEnvironment: string | undefined;
  variables: Variables;
  timeoutMs: number;
  auth: AuthSession | undefined;
}

/**
 * Autopilot (M4, ADR-0008): "Test everything", Run Flow, and watch mode (saving a file with
 * route handlers runs their requests again). Every run goes through core's runner, so results
 * here match `routelens run` in CI.
 */
export class TestRunner implements vscode.Disposable {
  private readonly summaries = new Map<string, RunSummary>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private saves: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TestRunnerDeps) {
    this.subscriptions = [
      this.changed,
      vscode.workspace.onDidSaveTextDocument((document) => {
        // One save after another, so two quick saves don't run the same requests at once.
        this.saves = this.saves.then(() => this.runAfterSave(document)).catch(() => undefined);
      }),
    ];
  }

  summary(root: string): RunSummary | undefined {
    return this.summaries.get(root);
  }

  /**
   * "Test everything": in every project, make the missing route drafts, then run every saved
   * request (reads first, deletes last) and every flow, one at a time. Returns one summary
   * per project that ran.
   */
  async testEverything(): Promise<RunSummary[]> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("RouteLens: trust this workspace to run requests.");
      return [];
    }
    const roots = await this.projectRoots();
    if (roots.length === 0) {
      void vscode.window.showInformationMessage(
        "RouteLens: nothing to test yet. Open a Next.js or Express project, or add requests to .routelens/.",
      );
      return [];
    }

    const summaries: RunSummary[] = [];
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "RouteLens: testing everything",
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        for (const root of roots) {
          if (controller.signal.aborted) break;
          const summary = await this.testProject(root, controller.signal, (text) =>
            progress.report({ message: text }),
          );
          if (summary) summaries.push(summary);
        }
      },
    );

    const passed = summaries.reduce((sum, item) => sum + item.passed, 0);
    const failed = summaries.reduce((sum, item) => sum + item.failed, 0);
    if (summaries.length > 0) {
      const durationMs = summaries.reduce((sum, item) => sum + item.durationMs, 0);
      const text = `RouteLens: ${testSummaryText(passed, failed, durationMs)}`;
      if (failed > 0) {
        void vscode.window
          .showWarningMessage(text, "Show results")
          .then((choice) => choice && vscode.commands.executeCommand("routelens.routes.focus"));
      } else {
        void vscode.window.showInformationMessage(text);
      }
    }
    return summaries;
  }

  /** Run one `.flow.json` (▶ Run flow above the file). */
  async runFlowFile(uri: vscode.Uri | undefined): Promise<LastResult | undefined> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("RouteLens: trust this workspace to run flows.");
      return undefined;
    }
    const document = uri
      ? await vscode.workspace.openTextDocument(uri)
      : vscode.window.activeTextEditor?.document;
    if (!document?.fileName.endsWith(FLOW_FILE_SUFFIX)) {
      void vscode.window.showInformationMessage(
        `RouteLens: open a ${FLOW_FILE_SUFFIX} file to run it.`,
      );
      return undefined;
    }
    const root = await findProjectRoot(path.dirname(document.uri.fsPath));
    if (!root) {
      void vscode.window.showInformationMessage(
        "RouteLens: this flow is not inside a .routelens folder.",
      );
      return undefined;
    }
    let flow: Flow;
    try {
      // The editor text, so unsaved edits run too.
      flow = parseFlow(document.getText(), path.basename(document.fileName));
    } catch (error) {
      this.reportFileError(error);
      return undefined;
    }

    const run = await this.prepare(root);
    if (!(await this.serverReady(root, run.variables.baseUrl))) return undefined;
    run.auth?.clearFailure();
    this.deps.results.set(document.uri, { kind: "sending" });
    try {
      const flowRun = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `RouteLens: ${flow.name}`,
          cancellable: true,
        },
        (progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return runFlow(flow, {
            root,
            file: document.uri.fsPath,
            variables: run.variables,
            send: this.sendOptions(run, controller.signal),
            ...(run.auth ? { auth: run.auth } : {}),
            onStep: (step) => progress.report({ message: `${step.index + 1}. ${step.name}` }),
          });
        },
      );
      const result = this.flowResult(document.uri, flow, flowRun, run);
      this.deps.panel.update(result);
      return result;
    } catch (error) {
      if (error instanceof RouteLensError && error.code === "aborted") {
        this.deps.output.appendLine("✕ cancelled");
        this.deps.results.delete(document.uri);
        return undefined;
      }
      throw error;
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  /**
   * Watch mode: after a save, rescan the file (so drafts follow the code), then run again the
   * requests of its routes that already ran. Requests nobody ran are never sent on save.
   */
  private async runAfterSave(document: vscode.TextDocument): Promise<void> {
    if (!vscode.workspace.isTrusted || !SOURCE_FILE.test(document.fileName)) return;
    if (!vscode.workspace.getConfiguration("routelens", document.uri).get("runOnSave", true))
      return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || this.deps.index.routesIn(document.uri).length === 0) return;

    const started = Date.now();
    await this.deps.index.refresh(folder.uri.fsPath);
    const targets = this.deps.index.routesIn(document.uri).flatMap(({ project, route }) => {
      const draft = project.drafts[route.key];
      const last = draft && this.deps.results.get(vscode.Uri.file(draft));
      return draft && last && last.kind !== "sending" ? [{ root: project.root, draft }] : [];
    });
    if (targets.length === 0) return;

    const runs = new Map<string, ProjectRun>();
    for (const { root, draft } of targets) {
      let request: ApiRequest;
      try {
        request = await readRequestFile(draft);
      } catch {
        continue; // a broken draft keeps its last result until it is fixed
      }
      const run = runs.get(root) ?? (await this.prepare(root));
      runs.set(root, run);
      const uri = vscode.Uri.file(draft);
      this.deps.results.set(uri, { kind: "sending" });
      let result = await this.runOne(request, draft, run);
      // A dev server restarting after the save refuses connections for a moment.
      const target = result.error?.code === "network" ? localServerOf(result.url) : undefined;
      if (target) {
        try {
          await waitForPort(target.port, { host: target.host, timeoutMs: RESTART_WAIT_MS });
          result = await this.runOne(request, draft, run);
        } catch {
          // Still down: keep the "can't connect" result.
        }
      }
      this.deps.results.set(uri, runToResult(result, run.shownEnvironment));
      this.deps.output.appendLine(runLine(result));
    }
    this.deps.output.appendLine(
      `Ran ${targets.length === 1 ? "1 request" : `${targets.length} requests`} again after saving ${path.basename(document.fileName)} (${Date.now() - started} ms).`,
    );
  }

  /** Run everything in one project. `undefined` when it could not start (server off, declined). */
  private async testProject(
    root: string,
    signal: AbortSignal,
    report: (text: string) => void,
  ): Promise<RunSummary | undefined> {
    const started = performance.now();
    const project = await this.ensureDrafts(root);
    if (!project) return undefined;
    const { requests, flows } = project;

    const run = await this.prepare(root);
    const resolved = requests.flatMap(({ request }) => {
      try {
        return [resolveRequest(request, run.variables).request];
      } catch {
        return [];
      }
    });
    const firstLocal = resolved.map((request) => request.url).find((url) => localServerOf(url));
    if (!(await this.serverReady(root, firstLocal ?? run.variables.baseUrl))) return undefined;
    if (!(await this.confirmRemoteWrites(resolved))) return undefined;
    run.auth?.clearFailure();

    this.deps.output.appendLine(`Test everything: ${path.basename(root)} (${run.environmentName})`);
    let passed = 0;
    let failed = 0;
    let cancelled = false;
    const total = requests.length + flows.length + project.broken.length;
    for (const file of project.broken) {
      failed += 1;
      this.deps.results.set(vscode.Uri.file(file.file), {
        kind: "error",
        code: "invalid-file",
        view: {
          requestName: path.basename(file.file),
          method: "",
          url: "",
          message: file.message,
          hint: undefined,
        },
      });
    }
    try {
      for (const [index, { file, request }] of orderForRun(requests).entries()) {
        report(`${index + 1} of ${total}: ${request.name}`);
        const uri = vscode.Uri.file(file);
        this.deps.results.set(uri, { kind: "sending" });
        const result = await this.runOne(request, file, run, signal);
        this.deps.results.set(uri, runToResult(result, run.shownEnvironment));
        this.deps.output.appendLine(`  ${runLine(result)}`);
        if (result.passed) passed += 1;
        else failed += 1;
      }
      for (const [index, file] of flows.entries()) {
        report(
          `${requests.length + index + 1} of ${total}: ${path.basename(file, FLOW_FILE_SUFFIX)}`,
        );
        const flowRun = await this.runFlowAt(file, run, signal);
        if (flowRun?.passed) passed += 1;
        else failed += 1;
      }
    } catch (error) {
      if (!(error instanceof RouteLensError && error.code === "aborted")) throw error;
      cancelled = true;
      this.deps.output.appendLine("  ✕ cancelled");
    }

    const summary: RunSummary = {
      root,
      passed,
      failed,
      durationMs: performance.now() - started,
      finishedAt: Date.now(),
      cancelled,
    };
    this.summaries.set(root, summary);
    this.changed.fire();
    this.deps.output.appendLine(`  ${testSummaryText(passed, failed, summary.durationMs)}`);
    return summary;
  }

  /**
   * Set the project up if needed and make a draft for every route without one: clicking
   * "Test everything" asks for every route, even ones whose draft was deleted.
   */
  private async ensureDrafts(root: string): Promise<
    | {
        requests: Array<{ file: string; request: ApiRequest; method: ApiRequest["method"] }>;
        flows: string[];
        broken: Array<{ file: string; message: string }>;
      }
    | undefined
  > {
    const { index, setup } = this.deps;
    if ((index.all().find((item) => item.root === root)?.result.routes.length ?? 0) > 0) {
      await ensureLocalEnvironment(root, setup);
    }
    await index.refresh(root);
    const project = index.all().find((item) => item.root === root);
    if (!project) return undefined;
    let created = 0;
    for (const route of project.result.routes) {
      const draft = project.drafts[route.key];
      if (draft && (await exists(draft))) continue;
      const file = await createRouteDraft(root, route);
      this.deps.output.appendLine(`  created ${path.relative(root, file)}`);
      created += 1;
    }
    if (created > 0) await index.refresh(root);

    const requests = [];
    const broken = [];
    for (const file of await listRequestFiles(root)) {
      try {
        const request = await readRequestFile(file);
        requests.push({ file, request, method: request.method });
      } catch (error) {
        broken.push({ file, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { requests, flows: await listFlowFiles(root), broken };
  }

  private async runFlowAt(
    file: string,
    run: ProjectRun,
    signal: AbortSignal,
  ): Promise<FlowRun | undefined> {
    const uri = vscode.Uri.file(file);
    let flow: Flow;
    try {
      flow = await readFlowFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.results.set(uri, {
        kind: "error",
        code: "invalid-file",
        view: { requestName: path.basename(file), method: "", url: "", message, hint: undefined },
      });
      this.deps.output.appendLine(`  ✗ ${path.basename(file)}: ${message}`);
      return undefined;
    }
    this.deps.results.set(uri, { kind: "sending" });
    const flowRun = await runFlow(flow, {
      root: run.root,
      file,
      variables: run.variables,
      send: this.sendOptions(run, signal),
      ...(run.auth ? { auth: run.auth } : {}),
    });
    this.flowResult(uri, flow, flowRun, run);
    return flowRun;
  }

  /** Store a flow's result and log its steps. */
  private flowResult(uri: vscode.Uri, flow: Flow, flowRun: FlowRun, run: ProjectRun): LastResult {
    const result: LastResult = {
      kind: "flow",
      view: { flowName: flow.name, environmentName: run.shownEnvironment, run: flowRun },
    };
    this.deps.results.set(uri, result);
    this.deps.output.appendLine(`  ${flowRun.passed ? "✓" : "✗"} flow "${flow.name}"`);
    for (const step of flowRun.steps) {
      this.deps.output.appendLine(`      ${runLine(step)}`);
    }
    for (const name of flowRun.skipped) this.deps.output.appendLine(`      – ${name}: not run`);
    const failedStep = flowRun.steps.find((step) => !step.passed);
    if (failedStep) this.deps.output.appendLine(`      ${stepProblem(failedStep)}`);
    return result;
  }

  private runOne(
    request: ApiRequest,
    file: string,
    run: ProjectRun,
    signal?: AbortSignal,
  ): Promise<RequestRun> {
    return runRequest(request, {
      variables: run.variables,
      send: this.sendOptions(run, signal),
      ...(run.auth ? { auth: run.auth } : {}),
      file,
    });
  }

  private sendOptions(run: ProjectRun, signal: AbortSignal | undefined): SendOptions {
    return signal ? { timeoutMs: run.timeoutMs, signal } : { timeoutMs: run.timeoutMs };
  }

  private async prepare(root: string): Promise<ProjectRun> {
    const environmentName = this.deps.environments.activeName();
    const environment = await readEnvironment(root, environmentName).catch(() => undefined);
    return {
      root,
      environmentName,
      shownEnvironment: environment ? environmentName : undefined,
      variables: environment?.variables ?? {},
      timeoutMs: vscode.workspace
        .getConfiguration("routelens", vscode.Uri.file(root))
        .get<number>("timeoutMs", 30_000),
      auth: await this.deps.logins.session(root, environmentName),
    };
  }

  /** The local server must answer before a batch: offer to start it (ADR-0006). */
  private async serverReady(root: string, url: string | undefined): Promise<boolean> {
    const target = url ? localServerOf(url) : undefined;
    if (!target || (await isPortOpen(target.port, { host: target.host }))) return true;
    const outcome = await this.deps.server.ensureRunning(root, target);
    this.deps.output.appendLine(`… ${target.host}:${target.port} was closed: ${outcome}`);
    // "unavailable": run anyway, so each request shows the real "can't connect" error.
    return outcome === "started" || outcome === "already-running" || outcome === "unavailable";
  }

  /** Writes to a server that is not this machine need a yes first. */
  private async confirmRemoteWrites(
    requests: ReadonlyArray<{ method: string; url: string }>,
  ): Promise<boolean> {
    const remote = requests.filter(
      (request) => WRITE_METHODS.has(request.method) && !localServerOf(request.url),
    );
    if (remote.length === 0) return true;
    const hosts = [...new Set(remote.map((request) => hostOf(request.url)))].join(", ");
    const choice = await vscode.window.showWarningMessage(
      `RouteLens: Test everything will send ${remote.length} POST, PUT, PATCH or DELETE request(s) to ${hosts}, which is not this machine. Send them?`,
      { modal: true },
      "Send them",
    );
    return choice === "Send them";
  }

  /** Workspace folders with routes or a .routelens folder. */
  private async projectRoots(): Promise<string[]> {
    await this.deps.index.refreshAll();
    return this.deps.index
      .all()
      .filter(
        (project) =>
          project.result.routes.length > 0 ||
          project.requests.length > 0 ||
          project.flows.length > 0,
      )
      .map((project) => project.root);
  }

  private reportFileError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.output.appendLine(`✕ ${message}`);
    if (error instanceof RouteLensError) {
      error.details.forEach((line) => this.deps.output.appendLine(`    ${line}`));
    }
    void vscode.window.showErrorMessage(`RouteLens: ${message}`);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
