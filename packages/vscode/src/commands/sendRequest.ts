import path from "node:path";
import * as vscode from "vscode";
import {
  REQUEST_FILE_SUFFIX,
  RouteLensError,
  findProjectRoot,
  isPortOpen,
  localServerOf,
  parseRequest,
  readEnvironment,
  resolveRequest,
  runRequest,
  type ApiRequest,
} from "@routelens/core";
import type { Environments } from "../environments";
import { runLine, runToResult, type LastResult } from "../inlineResult";
import type { Logins } from "../logins";
import type { ResponsePanel } from "../responsePanel";
import type { ResultStore } from "../results";
import type { ServerManager } from "../serverManager";

interface SendRequestContext {
  uri: vscode.Uri | undefined;
  panel: ResponsePanel;
  output: vscode.OutputChannel;
  results: ResultStore;
  server: ServerManager;
  environments: Environments;
  logins: Logins;
}

/** Sends a `.req.json` file. Returns the result (also shown inline), or `undefined` if nothing was sent. */
export async function sendRequestCommand(
  context: SendRequestContext,
): Promise<LastResult | undefined> {
  const { uri, panel, output, results, server, environments, logins } = context;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("RouteLens: trust this workspace to send requests.");
    return undefined;
  }

  const document = uri
    ? await vscode.workspace.openTextDocument(uri)
    : vscode.window.activeTextEditor?.document;
  if (!document || !document.fileName.endsWith(REQUEST_FILE_SUFFIX)) {
    void vscode.window.showInformationMessage(
      `RouteLens: open a ${REQUEST_FILE_SUFFIX} file to send it.`,
    );
    return undefined;
  }

  let request: ApiRequest;
  try {
    // Use the editor text, not the file on disk, so unsaved edits are sent too.
    request = parseRequest(document.getText(), path.basename(document.fileName));
  } catch (error) {
    reportError(error, output);
    results.delete(document.uri);
    return undefined;
  }

  const config = vscode.workspace.getConfiguration("routelens", document.uri);
  const environmentName = environments.activeName();
  const timeoutMs = config.get<number>("timeoutMs", 30_000);
  const root = await findProjectRoot(path.dirname(document.uri.fsPath));
  const environment = root ? await readEnvironment(root, environmentName) : undefined;
  const variables = environment?.variables ?? {};

  let url = request.url;
  try {
    const { request: resolved, missingVariables } = resolveRequest(request, variables);
    url = resolved.url;
    if (missingVariables.length > 0) {
      const where = environment ? `the "${environmentName}" environment` : "any environment";
      const choice = await vscode.window.showWarningMessage(
        `RouteLens: ${missingVariables.map((name) => `{{${name}}}`).join(", ")} not defined in ${where}.`,
        "Send anyway",
      );
      if (choice !== "Send anyway") return undefined;
    }
  } catch (error) {
    // A request that cannot be resolved (a body on GET...) fails in the runner with its reason.
    if (!(error instanceof RouteLensError)) throw error;
  }

  // Zero setup (ADR-0006): a request to this machine with nothing answering → offer to
  // start the dev server, wait for it, then send. ~300 ms TCP check, local URLs only.
  const target = localServerOf(url);
  if (target && root && !(await isPortOpen(target.port, { host: target.host }))) {
    const outcome = await server.ensureRunning(root, target);
    output.appendLine(`… ${target.host}:${target.port} was closed: ${outcome}`);
    // "unavailable": send anyway, so the user sees the real "can't connect" error.
    if (outcome !== "started" && outcome !== "already-running" && outcome !== "unavailable") {
      return undefined;
    }
  }

  // Auto-login (ADR-0008): a click is a new try, even after a failed login.
  const auth = root ? await logins.session(root, environmentName) : undefined;
  auth?.clearFailure();

  results.set(document.uri, { kind: "sending" });
  output.appendLine(`→ ${request.method} ${url}`);
  let run;
  try {
    run = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `RouteLens: ${request.method} ${url}`,
        cancellable: true,
      },
      (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return runRequest(request, {
          variables,
          send: { timeoutMs, signal: controller.signal },
          ...(auth ? { auth } : {}),
          allowMissingVariables: true,
          file: document.uri.fsPath,
        });
      },
    );
  } catch (error) {
    if (error instanceof RouteLensError && error.code === "aborted") {
      output.appendLine("✕ cancelled");
      results.delete(document.uri);
      return undefined;
    }
    throw error;
  }
  output.appendLine(runLine(run));

  const result = runToResult(run, environment ? environmentName : undefined);
  results.set(document.uri, result);
  panel.update(result);
  // Ticks the "Send your first request" walkthrough step.
  void vscode.commands.executeCommand("setContext", "routelens.sentRequest", true);

  if (run.error) {
    void vscode.window.showErrorMessage(`RouteLens: ${run.error.message}`);
  } else if (run.loginProblem && root) {
    void offerNewLogin(run.loginProblem, () => logins.forget(root, environmentName), document.uri);
  }
  return result;
}

/** After a failed login: offer to type the username and password again, then send again. */
async function offerNewLogin(
  problem: string,
  forget: () => Promise<void>,
  uri: vscode.Uri,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(`RouteLens: ${problem}`, "Log in again");
  if (choice !== "Log in again") return;
  await forget();
  await vscode.commands.executeCommand("routelens.sendRequest", uri);
}

function reportError(error: unknown, output: vscode.OutputChannel): void {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`✕ ${message}`);
  if (error instanceof RouteLensError) {
    error.details.forEach((line) => output.appendLine(`    ${line}`));
  }
  void vscode.window.showErrorMessage(`RouteLens: ${message}`);
}
