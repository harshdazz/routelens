import * as assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  isPortOpen,
  lensTitles,
  routeLensTaskIsRunning,
  waitFor,
  type SendResult,
} from "./helpers";

/** What `routelens.testEverything` returns (see src/testRunner.ts). */
type RunSummary = { root: string; passed: number; failed: number; cancelled: boolean };
/** What `routelens.runFlow` returns. */
type FlowResult =
  { kind: "flow"; view: { run: { passed: boolean; steps: unknown[] } } } | undefined;

// Runs inside a real VS Code with a fresh project (see ../runTest.mjs): a package.json with
// `"dev": "node server.js"`, a server.js that listens on ROUTELENS_E2E_PORT, and routes.js and
// auth.js (Express code that is only read, never run). No .routelens/.

const workspace = process.env.ROUTELENS_E2E_WORKSPACE ?? "";
const port = Number(process.env.ROUTELENS_E2E_PORT);
const environmentFile = path.join(workspace, ".routelens", "environments", "local.env.json");
const firstRequest = vscode.Uri.file(
  path.join(workspace, ".routelens", "requests", "first-request.req.json"),
);
const routesFile = vscode.Uri.file(path.join(workspace, "routes.js"));
const flowFile = vscode.Uri.file(path.join(workspace, ".routelens", "flows", "smoke.flow.json"));
const settings = () => vscode.workspace.getConfiguration("routelens");

/** What `routelens.scanRoutes` returns (see src/commands/routes.ts). */
type ScannedProject = {
  root: string;
  routes: Array<{ key: string }>;
  drafts: Record<string, string>;
};
const scannedRoutes = () =>
  waitFor("routes", async () => {
    const projects = await vscode.commands.executeCommand<ScannedProject[]>(
      "routelens.scanRoutes",
      {
        quiet: true,
      },
    );
    return projects.some((project) => project.routes.length > 0) ? projects : undefined;
  });
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
      "routelens.scanRoutes",
      "routelens.sendRoute",
      "routelens.openRouteRequest",
      "routelens.openRouteSource",
      "routelens.testEverything",
      "routelens.runFlow",
      "routelens.logOut",
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

  test("finds the routes in the code and makes a request for each (M3)", async () => {
    const [project] = await scannedRoutes();
    assert.ok(project);
    assert.deepEqual(
      project.routes.map((route) => route.key),
      ["GET /api/health", "POST /api/items", "POST /api/login", "GET /api/me"],
    );
    const draft = JSON.parse(await readFile(project.drafts["POST /api/items"] ?? "", "utf8"));
    assert.equal(draft.url, "{{baseUrl}}/api/items");
    assert.deepEqual(draft.body, { type: "json", content: { name: "example", qty: 1 } });
  });

  test("shows ▶ Send above each route handler", async () => {
    await vscode.window.showTextDocument(routesFile);
    const lenses = await waitFor("route code lenses", async () => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        routesFile,
      );
      return found.length >= 2 ? found : undefined;
    });
    assert.deepEqual(
      lenses.map((lens) => [lens.range.start.line + 1, lens.command?.title]),
      [
        [11, "$(play) Send GET /api/health"],
        [13, "$(play) Send POST /api/items"],
      ],
    );
  });

  test("▶ Send on a route sends its request and shows the result above the handler", async () => {
    const [project] = await scannedRoutes();
    const result = await vscode.commands.executeCommand<SendResult>("routelens.sendRoute", {
      root: project?.root,
      key: "POST /api/items",
    });
    assert.equal(result?.kind === "response" && result.view.response.status, 200);
    // The test server echoes the path it was called with.
    const body =
      result?.kind === "response" ? (result.view.response as { body?: string }).body : "";
    assert.match(body ?? "", /"path":"\/api\/items"/);
    const titles = await lensTitles(routesFile);
    assert.ok(
      titles.some((title) => /^✓ 200 OK · [\d.]+ m?s$/.test(title)),
      titles.join(" | "),
    );
  });

  test("when the code changes, the request follows and keeps your edits", async () => {
    const [project] = await scannedRoutes();
    const draftFile = project?.drafts["POST /api/items"] ?? "";
    const draft = JSON.parse(await readFile(draftFile, "utf8"));
    draft.body.content.name = "My item"; // the user's edit
    await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`);

    const source = await readFile(routesFile.fsPath, "utf8");
    await writeFile(
      routesFile.fsPath,
      source.replace(
        "qty: z.number().int().positive(),",
        "qty: z.number().int().positive(),\n  tags: z.array(z.string()).min(1),",
      ),
    );
    const content = await waitFor("the draft to follow the schema", async () => {
      const current = JSON.parse(await readFile(draftFile, "utf8"));
      return "tags" in current.body.content ? current.body.content : undefined;
    });
    assert.deepEqual(content, { name: "My item", qty: 1, tags: ["example"] });
  });

  test("Test everything runs every route and flow, logging in once (M4)", async () => {
    await mkdir(path.dirname(flowFile.fsPath), { recursive: true });
    await writeFile(
      flowFile.fsPath,
      JSON.stringify({
        version: 1,
        name: "Smoke",
        steps: [
          { request: { method: "GET", url: "{{baseUrl}}/api/health" }, extract: { n: "body.n" } },
          {
            request: { method: "GET", url: "{{baseUrl}}/api/items?after={{n}}" },
            expect: { status: 200, values: { "body.path": "/api/items?after={{n}}" } },
          },
        ],
      }),
    );

    // The person types their login once, when GET /api/me answers 401.
    const asked: string[] = [];
    const showInputBox = vscode.window.showInputBox;
    vscode.window.showInputBox = async (options) => {
      asked.push(options?.placeHolder ?? "");
      return options?.password ? "e2e-password" : "ada@example.com";
    };
    let summaries: RunSummary[];
    try {
      summaries =
        (await vscode.commands.executeCommand<RunSummary[]>("routelens.testEverything")) ?? [];
    } finally {
      vscode.window.showInputBox = showInputBox;
    }
    // 5 requests (the first request and 4 route drafts) and 1 flow.
    assert.deepEqual(
      summaries.map(({ passed, failed, cancelled }) => ({ passed, failed, cancelled })),
      [{ passed: 6, failed: 0, cancelled: false }],
    );
    assert.deepEqual(asked, ["email", "password"]);

    const titles = await lensTitles(routesFile);
    assert.equal(
      titles.filter((title) => title.startsWith("✓ 200 OK")).length,
      2,
      titles.join(" | "),
    );
    // Code lenses are only computed for open documents.
    await vscode.workspace.openTextDocument(flowFile);
    assert.ok(
      (await lensTitles(flowFile)).some((title) => /^✓ 2 steps · /.test(title)),
      "the flow shows its result",
    );

    // The token is reused: sending the protected route again asks nothing.
    const [project] = await scannedRoutes();
    const me = await vscode.commands.executeCommand<SendResult>(
      "routelens.sendRequest",
      vscode.Uri.file(project?.drafts["GET /api/me"] ?? ""),
    );
    assert.equal(me?.kind === "response" && me.view.response.status, 200);
    assert.equal(asked.length, 2);
  });

  test("▶ Run flow runs each step and shows the result above the file", async () => {
    const result = await vscode.commands.executeCommand<FlowResult>("routelens.runFlow", flowFile);
    assert.equal(result?.kind, "flow");
    assert.equal(result?.view.run.passed, true);
    assert.equal(result?.view.run.steps.length, 2);
    const [run, inline] = await lensTitles(flowFile);
    assert.equal(run, "$(play) Run flow");
    assert.match(inline ?? "", /^✓ 2 steps · /);
  });

  test("saving a route file runs its requests again within 2 seconds", async () => {
    const counter = async (): Promise<string | undefined> => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        routesFile,
      );
      // The result lens sits on the same line as "▶ Send POST /api/items".
      const send = lenses.find((lens) => lens.command?.title === "$(play) Send POST /api/items");
      const result = lenses.find(
        (lens) => send && lens !== send && lens.range.start.line === send.range.start.line,
      );
      return /"n": (\d+)/.exec(result?.command?.tooltip ?? "")?.[1];
    };
    const before = await waitFor("the last result of POST /api/items", counter);

    const document = await vscode.workspace.openTextDocument(routesFile);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      routesFile,
      new vscode.Position(document.lineCount, 0),
      "// saved by the e2e test\n",
    );
    await vscode.workspace.applyEdit(edit);
    const saved = Date.now();
    await document.save();

    const after = await waitFor("a new result", async () => {
      const value = await counter();
      return value !== undefined && value !== before ? value : undefined;
    });
    const elapsed = Date.now() - saved;
    assert.ok(Number(after) > Number(before));
    assert.ok(elapsed < 2_000, `ran again ${elapsed} ms after the save`);
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
