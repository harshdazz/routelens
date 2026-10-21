import { execSync, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPortOpen, waitForPort } from "@routelens/core";
import { createServer } from "../../src/server";

// M5 acceptance (docs/03-roadmap.md), scripted: what an AI agent does with RouteLens to
// "test my API and fix what's broken" on fixtures/buggy-api, a todo API with one planted bug.
// The real check with Claude Code and Copilot agent mode is done by hand; this test proves
// the tools give an agent everything it needs: the failure, the route and the line.
//
//   pnpm test:acceptance:mcp   (runs `npm ci` in a copy of the fixture; needs port 3456)

const PORT = 3456;
const fixture = fileURLToPath(new URL("../../../../fixtures/buggy-api", import.meta.url));
let workspace: string;
let server: ChildProcess | undefined;
let call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;

const textOf = (result: CallToolResult, index = 0): string => {
  const item = result.content[index];
  return item?.type === "text" ? item.text : "";
};
const jsonOf = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>;

async function startApi(): Promise<void> {
  server = spawn(process.execPath, ["src/server.js"], { cwd: workspace, stdio: "ignore" });
  await waitForPort(PORT, { timeoutMs: 30_000 });
}

async function stopApi(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server?.once("exit", resolve));
  server.kill();
  await exited;
  for (let tries = 0; tries < 50 && (await isPortOpen(PORT)); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  if (await isPortOpen(PORT))
    throw new Error(`Port ${PORT} is in use. Stop what runs there, then try again.`);
  workspace = await mkdtemp(path.join(tmpdir(), "routelens-buggy-api-"));
  await cp(fixture, workspace, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|\.routelens)([\\/]|$)/.test(source),
  });
  execSync("npm ci --no-audit --no-fund", { cwd: workspace, stdio: "ignore" });
  await startApi();

  const mcp = createServer({ root: workspace });
  const client = new Client({ name: "acceptance-agent", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
});

afterAll(async () => {
  await stopApi();
  if (workspace)
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

describe("M5 acceptance: an agent tests the API and finds what's broken", () => {
  it("1. list_routes: every route, with no setup at all (no .routelens/)", async () => {
    const routes = jsonOf(await call("list_routes"));
    expect(routes.environment).toMatchObject({
      baseUrl: `http://localhost:${PORT}`,
      from: expect.stringMatching(/^detected from /),
    });
    expect(
      (routes.routes as Array<{ route: string; source: string }>).map(
        (item) => `${item.route} @ ${item.source}`,
      ),
    ).toEqual([
      "GET /api/health @ src/server.js:7",
      "GET /api/todos @ src/routes/todos.js:12",
      "POST /api/todos @ src/routes/todos.js:16",
      "GET /api/todos/:id @ src/routes/todos.js:23",
      "PATCH /api/todos/:id @ src/routes/todos.js:29",
      "DELETE /api/todos/:id @ src/routes/todos.js:36",
    ]);
  });

  it("2. run_all: one route fails", async () => {
    const run = jsonOf(await call("run_all"));
    expect(run).toMatchObject({ passed: 5, failed: 1 });
    expect(
      (run.results as Array<{ name: string; passed: boolean }>).filter((item) => !item.passed),
    ).toEqual([
      expect.objectContaining({
        name: "GET /api/todos/:id",
        route: "GET /api/todos/:id (src/routes/todos.js:23)",
      }),
    ]);
  });

  it("3. get_last_failure: the 404, and the code with the line to fix", async () => {
    const failure = await call("get_last_failure");
    expect(jsonOf(failure)).toMatchObject({
      failed: "GET /api/todos/:id",
      sent: { method: "GET", url: `http://localhost:${PORT}/api/todos/1` },
      response: { status: 404, body: { error: "Todo not found" } },
    });
    const code = textOf(failure, 1);
    expect(code).toContain('→23 | router.get("/:id", (req, res) => {');
    expect(code).toContain(" 24 |   const todo = todos.find((item) => item.id === req.params.id);");
    // The routes next to it compare with Number(req.params.id): the clue to the fix.
    expect(code).toContain("item.id === Number(req.params.id)");
  });

  it("4. after the fix the agent would propose, everything passes", async () => {
    const file = path.join(workspace, "src", "routes", "todos.js");
    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      source.replace("item.id === req.params.id", "item.id === Number(req.params.id)"),
    );
    await stopApi();
    await startApi();
    expect(jsonOf(await call("run_all"))).toMatchObject({ passed: 6, failed: 0 });
    expect(jsonOf(await call("get_last_failure"))).toMatchObject({ failure: null });
  });
});
