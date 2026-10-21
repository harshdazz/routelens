import { stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  HTTP_METHODS,
  METHODS_WITHOUT_BODY,
  findProjectRoot,
  requestFilePath,
  writeRequestFile,
  type HttpMethod,
} from "@routelens/core";
import { ensureLocalEnvironment, type SetupDeps } from "../setup";

export async function newRequestCommand(setup: SetupDeps): Promise<void> {
  const root = await chooseProjectRoot();
  if (!root) {
    void vscode.window.showInformationMessage("RouteLens: open a folder first.");
    return;
  }

  const name = await vscode.window.showInputBox({
    title: "New request (1/3)",
    prompt: "Request name",
    placeHolder: "Create post",
    validateInput: (value) => (value.trim() ? undefined : "A name is required."),
  });
  if (!name) return;

  const method = (await vscode.window.showQuickPick([...HTTP_METHODS], {
    title: "New request (2/3)",
    placeHolder: "HTTP method",
  })) as HttpMethod | undefined;
  if (!method) return;

  const url = await vscode.window.showInputBox({
    title: "New request (3/3)",
    prompt: "URL (you can use {{variables}})",
    value: "{{baseUrl}}/",
    valueSelection: [12, 12],
  });
  if (url === undefined) return;

  const filePath = requestFilePath(root, name.trim());
  if (await exists(filePath)) {
    void vscode.window.showWarningMessage(
      `RouteLens: ${path.basename(filePath)} already exists. Opening it instead.`,
    );
  } else {
    await writeRequestFile(filePath, {
      version: 1,
      name: name.trim(),
      method,
      url: url.trim(),
      headers: {},
      query: {},
      body: METHODS_WITHOUT_BODY.includes(method)
        ? { type: "none" }
        : { type: "json", content: {} },
    });
  }

  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document);
  // First request in this project? Find the API so {{baseUrl}} works right away (ADR-0006).
  await ensureLocalEnvironment(root, setup);
}

/** Prefer the project of the active file, then the only workspace folder, then ask. */
async function chooseProjectRoot(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    const root = await findProjectRoot(path.dirname(active.fsPath));
    if (root) return root;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0]?.uri.fsPath;
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: "Where should the request be saved?",
  });
  return picked?.uri.fsPath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
