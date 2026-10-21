import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  isPortOpen,
  lensTitles,
  routeLensTaskIsRunning,
  waitFor,
  type SendResult,
} from "./helpers";

// M2 acceptance (docs/03-roadmap.md): "on a fresh Next.js fixture with its server off,
// install → click Send → 200, with no typed commands and no hand-written files."
// runTest.mjs copies fixtures/next-default to a temp folder and runs `npm ci` there first.

const workspace = process.env.ROUTELENS_E2E_WORKSPACE ?? "";
const NEXT_PORT = 3000;
const firstRequest = vscode.Uri.file(
  path.join(workspace, ".routelens", "requests", "first-request.req.json"),
);

/**
 * Click "▶ Start server" on RouteLens's prompt, the way a user would. VS Code's
 * `notification.acceptPrimaryAction` presses the first button of the newest notification.
 * Keep trying until the prompt has appeared and the server task has started.
 */
async function clickStartServer(): Promise<void> {
  await waitFor(
    "the Start server prompt",
    async () => {
      if (routeLensTaskIsRunning()) return true;
      await vscode.commands.executeCommand("notification.acceptPrimaryAction");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return routeLensTaskIsRunning() || undefined;
    },
    30_000,
  );
}

suite("M2 acceptance: fresh Next.js project with its server off", () => {
  suiteSetup(async () => {
    await vscode.workspace
      .getConfiguration("routelens")
      .update("autoStartServer", undefined, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("routelens.stopServer");
  });

  test("install → click Send → 200", async () => {
    // Install: activating in the project finds the API and writes the files by itself.
    const environment = await waitFor("local.env.json", () =>
      readFile(path.join(workspace, ".routelens", "environments", "local.env.json"), "utf8").catch(
        () => undefined,
      ),
    );
    assert.equal(JSON.parse(environment).variables.baseUrl, `http://localhost:${NEXT_PORT}`);
    assert.equal(await isPortOpen(NEXT_PORT), false, "the Next.js server is off");

    // Click ▶ Send (what the CodeLens runs), then ▶ Start server on the prompt.
    await vscode.window.showTextDocument(firstRequest);
    await vscode.commands.executeCommand("notifications.clearAll");
    const sending = vscode.commands.executeCommand<SendResult>(
      "routelens.sendRequest",
      firstRequest,
    );
    await clickStartServer();
    const result = await sending;

    assert.equal(result?.kind, "response", JSON.stringify(result));
    assert.equal(result.kind === "response" && result.view.response.status, 200);
    const [, inline] = await lensTitles(firstRequest);
    assert.match(inline ?? "", /^✓ 200 OK · [\d.]+ m?s$/);
  });
});
