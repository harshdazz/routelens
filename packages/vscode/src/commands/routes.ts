import { access } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { createRouteDraft } from "@routelens/core";
import type { LastResult } from "../inlineResult";
import type { RouteIndex, RouteTarget } from "../routeIndex";
import { scanSummary } from "../routeText";
import { ensureLocalEnvironment, type SetupDeps } from "../setup";

interface RouteCommandDeps {
  index: RouteIndex;
  setup: SetupDeps;
}

/**
 * ▶ Send on a route (CodeLens above the handler, or the Routes view): send its draft request.
 * If the draft is missing (never made, or deleted by the user), clicking makes it again.
 */
export async function sendRouteCommand(
  target: RouteTarget | undefined,
  deps: RouteCommandDeps,
): Promise<LastResult | undefined> {
  const file = target && (await routeRequestFile(target, deps));
  if (!file) return undefined;
  return vscode.commands.executeCommand<LastResult | undefined>(
    "routelens.sendRequest",
    vscode.Uri.file(file),
  );
}

/** Open the draft request of a route, making it first if needed. */
export async function openRouteRequestCommand(
  target: RouteTarget | undefined,
  deps: RouteCommandDeps,
): Promise<void> {
  const file = target && (await routeRequestFile(target, deps));
  if (file) await vscode.window.showTextDocument(vscode.Uri.file(file));
}

/** Scan again (button in the Routes view). Returns what was found, for tests and scripts. */
export async function scanRoutesCommand(deps: RouteCommandDeps, notify: boolean) {
  await deps.index.refreshAll();
  const projects = deps.index.all();
  if (notify) {
    const count = projects.reduce((sum, project) => sum + project.result.routes.length, 0);
    const frameworks = projects.flatMap((project) => project.result.frameworks);
    void vscode.window.showInformationMessage(`RouteLens: ${scanSummary(count, frameworks)}`);
  }
  return projects.map((project) => ({
    root: project.root,
    routes: project.result.routes,
    skipped: project.result.skipped,
    drafts: project.drafts,
  }));
}

async function routeRequestFile(
  target: RouteTarget,
  deps: RouteCommandDeps,
): Promise<string | undefined> {
  if (!deps.index.find(target)) {
    await deps.index.refresh(target.root);
    if (!deps.index.find(target)) {
      void vscode.window.showInformationMessage(
        `RouteLens: ${target.key} is no longer in the code.`,
      );
      return undefined;
    }
  }
  const existing = deps.index.find(target)?.project.drafts[target.key];
  if (existing && (await exists(existing))) return existing;

  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      "RouteLens: trust this workspace to make and send requests.",
    );
    return undefined;
  }
  // Not set up yet: create .routelens/ (finding the API address), which also makes the drafts.
  await ensureLocalEnvironment(target.root, deps.setup);
  await deps.index.refresh(target.root);

  const found = deps.index.find(target);
  if (!found) return undefined;
  const draft = found.project.drafts[target.key];
  if (draft && (await exists(draft))) return draft;
  // The user deleted this draft earlier; a click is a clear request to make it again.
  const created = await createRouteDraft(target.root, found.route);
  deps.setup.output.appendLine(`  created ${path.relative(target.root, created)}`);
  await deps.index.refresh(target.root);
  return created;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
