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
  sendRequest,
  type ApiRequest,
} from "@routelens/core";
import type { Environments } from "../environments";
import type { LastResult } from "../inlineResult";
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
}

/** Sends a `.req.json` file. Returns the result (also shown inline), or `undefined` if nothing was sent. */
export async function sendRequestCommand({
  uri,
  panel,
  output,
  results,
  server,
  environments,
}: SendRequestContext): Promise<LastResult | undefined> {
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

  let request: ApiRequest | undefined;
  let url = "";
  try {
    // Use the editor text, not the file on disk, so unsaved edits are sent too.
    request = parseRequest(document.getText(), path.basename(document.fileName));
    url = request.url;

    const config = vscode.workspace.getConfiguration("routelens", document.uri);
    const environmentName = environments.activeName();
    const timeoutMs = config.get<number>("timeoutMs", 30_000);

    const root = await findProjectRoot(path.dirname(document.uri.fsPath));
    const environment = root ? await readEnvironment(root, environmentName) : undefined;
    const { request: resolved, missingVariables } = resolveRequest(
      request,
      environment?.variables ?? {},
    );
    url = resolved.url;

    if (missingVariables.length > 0) {
      const where = environment ? `the "${environmentName}" environment` : "any environment";
      const choice = await vscode.window.showWarningMessage(
        `RouteLens: ${missingVariables.map((name) => `{{${name}}}`).join(", ")} not defined in ${where}.`,
        "Send anyway",
      );
      if (choice !== "Send anyway") return undefined;
    }

    // Zero setup (ADR-0006): a request to this machine with nothing answering → offer to
    // start the dev server, wait for it, then send. ~300 ms TCP check, local URLs only.
    const target = localServerOf(resolved.url);
    if (target && root && !(await isPortOpen(target.port, { host: target.host }))) {
      const outcome = await server.ensureRunning(root, target);
      output.appendLine(`… ${target.host}:${target.port} was closed: ${outcome}`);
      // "unavailable": send anyway, so the user sees the real "can't connect" error.
      if (outcome !== "started" && outcome !== "already-running" && outcome !== "unavailable") {
        return undefined;
      }
    }

    results.set(document.uri, { kind: "sending" });
    output.appendLine(`→ ${resolved.method} ${resolved.url}`);
    const response = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `RouteLens: ${resolved.method} ${resolved.url}`,
        cancellable: true,
      },
      (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return sendRequest(resolved, { timeoutMs, signal: controller.signal });
      },
    );
    output.appendLine(
      `← ${response.status} ${response.statusText} in ${Math.round(response.durationMs)} ms`,
    );

    const result: LastResult = {
      kind: "response",
      view: {
        requestName: request.name,
        method: resolved.method,
        url: resolved.url,
        environmentName: environment ? environmentName : undefined,
        response,
      },
    };
    results.set(document.uri, result);
    panel.update(result);
    // Ticks the "Send your first request" walkthrough step.
    void vscode.commands.executeCommand("setContext", "routelens.sentRequest", true);
    return result;
  } catch (error) {
    if (error instanceof RouteLensError && error.code === "aborted") {
      output.appendLine("✕ cancelled");
      results.delete(document.uri);
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`✕ ${message}`);
    if (error instanceof RouteLensError) {
      error.details.forEach((line) => output.appendLine(`    ${line}`));
    }

    let result: LastResult | undefined;
    if (request && error instanceof RouteLensError && error.code !== "invalid-file") {
      result = {
        kind: "error",
        code: error.code,
        view: {
          requestName: request.name,
          method: request.method,
          url,
          message,
          hint: hintFor(error),
        },
      };
      results.set(document.uri, result);
      panel.update(result);
    } else {
      results.delete(document.uri);
    }
    void vscode.window.showErrorMessage(`RouteLens: ${message}`);
    return result;
  }
}

function hintFor(error: RouteLensError): string | undefined {
  switch (error.code) {
    case "network":
      return 'Is your server running? Run "RouteLens: Start Server", or check the address with "RouteLens: Change Server Address".';
    case "timeout":
      return "Increase the routelens.timeoutMs setting if the endpoint is slow.";
    case "invalid-request":
      return "Check the URL and the environment selected in the status bar.";
    default:
      return undefined;
  }
}
