import * as vscode from "vscode";
import {
  DEFAULT_ENVIRONMENT,
  createProjectFiles,
  describeClue,
  detectServer,
  listRequestFiles,
  normalizeBaseUrl,
  readEnvironment,
  setEnvironmentVariables,
  type AddressCandidate,
  type ServerDetection,
} from "@routelens/core";
import { hasRouteLensFolder } from "./environments";

const AUTO_SETUP_KEY = "routelens.autoSetupDone";

/** Ports offered in the Change picker when the project gave no clue. */
const COMMON_ADDRESSES: ReadonlyArray<readonly [string, string]> = [
  ["http://localhost:3000", "Next.js, Express, NestJS"],
  ["http://localhost:5173", "Vite"],
  ["http://localhost:8080", "common default"],
  ["http://localhost:4000", "common default"],
];

export interface SetupDeps {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  /** Called after `.routelens/` files were created or changed. */
  onProjectChanged: () => void;
}

/**
 * On activation (ADR-0006): in a trusted folder with a package.json and no `.routelens/` yet,
 * find the API and create `local.env.json` plus a first request. Runs once per folder: if the
 * user deletes `.routelens/` later, RouteLens does not put it back by itself.
 */
export async function autoSetUp(folder: vscode.WorkspaceFolder, deps: SetupDeps): Promise<void> {
  const root = folder.uri.fsPath;
  const doneFolders = deps.context.workspaceState.get<string[]>(AUTO_SETUP_KEY, []);
  if (!vscode.workspace.isTrusted || doneFolders.includes(root)) return;
  if (await hasRouteLensFolder(root)) {
    await markDone(deps, root);
    return;
  }

  const detection = await detect(root, deps);
  if (!detection) return; // no package.json here: not a JavaScript project
  await markDone(deps, root);

  if (!detection.address) {
    // A project that can be started but gave no port clue: ask once, without blocking.
    if (detection.start) {
      const choice = await vscode.window.showInformationMessage(
        "RouteLens: I couldn't tell which address your API uses.",
        "Choose address",
      );
      if (choice) await changeServerAddress(root, deps, detection);
    }
    return;
  }
  await createFiles(root, detection.address, deps, detection);
}

/** "RouteLens: Set Up Project" (also the walkthrough's first step). Asks if nothing was found. */
export async function setUpProject(root: string, deps: SetupDeps): Promise<void> {
  const detection = await detect(root, deps);
  const existing = await readEnvironment(root, DEFAULT_ENVIRONMENT).catch(() => undefined);
  if (existing?.variables.baseUrl) {
    const created = await createProjectFiles(root, existing.variables.baseUrl);
    if (created.requestFile) deps.onProjectChanged();
    const choice = await vscode.window.showInformationMessage(
      `RouteLens: this project is set up. Requests use ${existing.variables.baseUrl}.`,
      "Open first request",
      "Change",
    );
    await handleChoice(choice, root, deps, detection);
    return;
  }
  if (detection?.address) {
    await createFiles(root, detection.address, deps, detection);
    return;
  }
  // "If unclear, ask once with suggestions" (ADR-0006).
  const baseUrl = await pickAddress(detection, undefined);
  if (!baseUrl) return;
  const created = await createProjectFiles(root, baseUrl);
  deps.onProjectChanged();
  if (created.requestFile) await openFirstRequest(root);
}

/** Make sure `local.env.json` exists before a new request uses `{{baseUrl}}`. */
export async function ensureLocalEnvironment(root: string, deps: SetupDeps): Promise<void> {
  if (await readEnvironment(root, DEFAULT_ENVIRONMENT).catch(() => undefined)) return;
  const detection = await detect(root, deps);
  if (detection?.address) await createFiles(root, detection.address, deps, detection);
}

/** "Change": pick another detected address, a common one, or type one. Saved to local.env.json. */
export async function changeServerAddress(
  root: string,
  deps: SetupDeps,
  detection?: ServerDetection,
): Promise<string | undefined> {
  const current = (await readEnvironment(root, DEFAULT_ENVIRONMENT).catch(() => undefined))
    ?.variables.baseUrl;
  const baseUrl = await pickAddress(detection ?? (await detect(root, deps)), current);
  if (!baseUrl) return undefined;

  await setEnvironmentVariables(root, DEFAULT_ENVIRONMENT, { baseUrl });
  if ((await listRequestFiles(root)).length === 0) await createProjectFiles(root, baseUrl);
  deps.onProjectChanged();
  void vscode.window.showInformationMessage(`RouteLens: requests now go to ${baseUrl}.`);
  return baseUrl;
}

/** Write the files and say "Found your API at … (from …)" with a Change button. */
async function createFiles(
  root: string,
  address: AddressCandidate,
  deps: SetupDeps,
  detection: ServerDetection | undefined,
): Promise<void> {
  const created = await createProjectFiles(root, address.baseUrl);
  deps.onProjectChanged();
  const source = describeClue(address);
  deps.output.appendLine(`Found your API at ${address.baseUrl} (from ${source})`);
  if (!created.environmentFile) return;

  const choice = await vscode.window.showInformationMessage(
    `RouteLens: Found your API at ${address.baseUrl} (from ${source}).`,
    ...(created.requestFile ? ["Open first request"] : []),
    "Change",
  );
  await handleChoice(choice, root, deps, detection);
}

async function handleChoice(
  choice: string | undefined,
  root: string,
  deps: SetupDeps,
  detection: ServerDetection | undefined,
): Promise<void> {
  if (choice === "Open first request") await openFirstRequest(root);
  if (choice === "Change") await changeServerAddress(root, deps, detection);
}

/** Opens the first `.req.json` of the project. Returns false when there is none. */
export async function openFirstRequest(root: string): Promise<boolean> {
  const [first] = await listRequestFiles(root);
  if (!first) return false;
  const document = await vscode.workspace.openTextDocument(first);
  await vscode.window.showTextDocument(document);
  return true;
}

async function pickAddress(
  detection: ServerDetection | undefined,
  current: string | undefined,
): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { baseUrl?: string };
  const items: Item[] = [];
  const seen = new Set<string>();
  const add = (baseUrl: string, description: string): void => {
    if (seen.has(baseUrl)) return;
    seen.add(baseUrl);
    items.push({
      baseUrl,
      label: baseUrl === current ? `$(check) ${baseUrl}` : baseUrl,
      description: baseUrl === current ? `current · ${description}` : description,
    });
  };
  for (const candidate of detection?.candidates ?? []) {
    add(candidate.baseUrl, `from ${describeClue(candidate)}`);
  }
  if (current) add(current, "local.env.json");
  for (const [baseUrl, description] of COMMON_ADDRESSES) add(baseUrl, description);
  items.push({ label: "$(edit) Enter another address..." });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Where does your API run?",
    placeHolder: "RouteLens saves it as baseUrl in .routelens/environments/local.env.json",
  });
  if (!picked) return undefined;
  if (picked.baseUrl) return picked.baseUrl;

  const typed = await vscode.window.showInputBox({
    title: "Where does your API run?",
    prompt: "Base URL, e.g. http://localhost:3000",
    value: current ?? "http://localhost:",
    validateInput: (value) =>
      normalizeBaseUrl(value) ? undefined : "Enter an http:// or https:// URL.",
  });
  return typed === undefined ? undefined : normalizeBaseUrl(typed);
}

async function detect(root: string, deps: SetupDeps): Promise<ServerDetection | undefined> {
  try {
    return await detectServer(root);
  } catch (error) {
    // A broken package.json should not break the editor: log it and carry on.
    deps.output.appendLine(`✕ ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function markDone(deps: SetupDeps, root: string): Promise<void> {
  const done = deps.context.workspaceState.get<string[]>(AUTO_SETUP_KEY, []);
  if (!done.includes(root))
    await deps.context.workspaceState.update(AUTO_SETUP_KEY, [...done, root]);
}
