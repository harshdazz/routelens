import * as assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  isPortOpen,
  lensTitles,
  routeLensTaskIsRunning,
  waitFor,
  type SendResult,
} from "./helpers";

// Runs inside a real VS Code with a fresh project (see ../runTest.mjs): a package.json with
// `"dev": "node server.js"` and a server.js that listens on ROUTELENS_E2E_PORT. No .routelens/.

const workspace = process.env.ROUTELENS_E2E_WORKSPACE ?? "";
const port = Number(process.env.ROUTELENS_E2E_PORT);
const environmentFile = path.join(workspace, ".routelens", "environments", "local.env.json");
const firstRequest = vscode.Uri.file(
  path.join(workspace, ".routelens", "requests", "first-request.req.json"),
);
const settings = () => vscode.workspace.getConfiguration("routelens");
const serverStopped = () =>
  waitFor("the server to stop", async () => ((await isPortOpen(port)) ? undefined : true));

suite("RouteLens zero setup", () => {
  suiteSetup(async () => {
    assert.ok(workspace, "run through runTest.mjs");
    // The test VS Code keeps its settings between runs.
    await settings().update("autoStartServer", undefined, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("routelens.stopServer");
    await settings().update("autoStartServer", undefined, vscode.ConfigurationTarget.Global);
  });

  test("activates in a folder that only has a package.json", async () => {
    const extension = vscode.extensions.getExtension("harshdazz.routelens");
    assert.ok(extension, "extension is installed");
    await waitFor("activation", async () => extension.isActive || undefined);
  });

  test("creates .routelens/ with the address it found in server.js", async () => {
    const text = await waitFor("local.env.json", () =>
      readFile(environmentFile, "utf8").catch(() => undefined),
    );
    assert.deepEqual(JSON.parse(text), {
      version: 1,
      name: "local",
      variables: { baseUrl: `http://localhost:${port}` },
    });
    assert.ok((await stat(firstRequest.fsPath)).isFile(), "first request was created");
  });

  test("registers its commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "routelens.sendRequest",
      "routelens.newRequest",
      "routelens.setUpProject",
      "routelens.changeServerAddress",
      "routelens.startServer",
      "routelens.stopServer",
      "routelens.selectEnvironment",
      "routelens.showLastResponse",
    ]) {
      assert.ok(commands.includes(command), `${command} is registered`);
    }
  });

  test("shows ▶ Send request at the top of a request file", async () => {
    await vscode.window.showTextDocument(firstRequest);
    const titles = await waitFor("code lenses", async () => {
      const found = await lensTitles(firstRequest);
      return found.length > 0 ? found : undefined;
    });
    assert.deepEqual(titles, ["$(play) Send request"]);
  });

  test("Start Server runs the dev script as a task and waits for the port", async () => {
    assert.equal(await isPortOpen(port), false, "server is off at the start");
    assert.equal(await vscode.commands.executeCommand("routelens.startServer"), "started");
    assert.equal(await isPortOpen(port), true);
    assert.ok(routeLensTaskIsRunning(), "the server runs as a visible RouteLens task");
  });

  test("Send shows the result inline, and a click opens it", async () => {
    const result = await vscode.commands.executeCommand<SendResult>(
      "routelens.sendRequest",
      firstRequest,
    );
    assert.equal(result?.kind, "response", JSON.stringify(result));
    assert.equal(result.kind === "response" && result.view.response.status, 200);

    const [send, inline] = await lensTitles(firstRequest);
    assert.equal(send, "$(play) Send request");
    assert.match(inline ?? "", /^✓ 200 OK · [\d.]+ m?s$/);
    // What a click on the inline result runs.
    await vscode.commands.executeCommand("routelens.showLastResponse", firstRequest);
  });

  test("with autoStartServer = always, Send starts a stopped server and sends again", async () => {
    assert.equal(await vscode.commands.executeCommand("routelens.stopServer"), 1);
    await serverStopped();

    await settings().update("autoStartServer", "always", vscode.ConfigurationTarget.Global);
    const result = await vscode.commands.executeCommand<SendResult>(
      "routelens.sendRequest",
      firstRequest,
    );
    assert.equal(result?.kind === "response" && result.view.response.status, 200);
    assert.equal(await isPortOpen(port), true);
  });

  test("reports a server that exits before its port opens", async () => {
    await vscode.commands.executeCommand("routelens.stopServer");
    await serverStopped();

    const packageJson = path.join(workspace, "package.json");
    const original = await readFile(packageJson, "utf8");
    await writeFile(
      packageJson,
      JSON.stringify({ name: "e2e-app", scripts: { dev: 'node -e "process.exit(3)"' } }),
    );
    try {
      assert.equal(await vscode.commands.executeCommand("routelens.startServer"), "crashed");
    } finally {
      await writeFile(packageJson, original);
    }
  });
});
