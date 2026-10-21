import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type RouteLensServerOptions } from "../src/server";

// The MCP server, driven by the SDK's own client over an in-memory transport: what an agent
// sees. The project's Express code is only read; a small test API answers its routes, with a
// planted bug: GET /api/todos/:id always answers 404.

const APP_JS = `const express = require("express");
const { z } = require("zod");

const NewTodo = z.object({ title: z.string().min(1) });
const app = express();
app.use(express.json());

app.get("/api/todos", (req, res) => res.json([]));

app.post("/api/todos", (req, res) => {
  const input = NewTodo.parse(req.body);
  res.status(201).json(input);
});

app.get("/api/todos/:id", (req, res) => {
  const todo = todos.find((item) => item.id === req.params.id);
  res.json(todo);
});

app.delete("/api/todos/:id", (req, res) => res.status(204).end());

module.exports = app;
`;

let api: Server;
let baseUrl: string;
let root: string;
const requests: string[] = [];

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
};

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      requests.push(`${req.method} ${req.url}`);
      const json = (status: number, data: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "GET" && req.url === "/api/todos") return json(200, []);
      if (req.method === "POST" && req.url === "/api/todos") {
        return typeof body.title === "string" && body.title
          ? json(201, { id: 1, title: body.title })
          : json(400, { error: "title is required" });
      }
      if (req.method === "GET" && req.url?.startsWith("/api/todos/"))
        return json(404, { error: "Todo not found" });
      if (req.method === "DELETE" && req.url?.startsWith("/api/todos/")) {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST" && req.url === "/api/login") {
        return body.password === "pw" ? json(200, { token: "tok" }) : json(401, { error: "no" });
      }
      if (req.method === "GET" && req.url === "/api/me") {
        return req.headers.authorization === "Bearer tok"
          ? json(200, { me: 1 })
          : json(401, { error: "log in" });
      }
      json(404, { error: "no route" });
    })();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "routelens-mcp-"));
  requests.length = 0;
  await write("package.json", {
    name: "todos",
    private: true,
    dependencies: { express: "^5.1.0", zod: "^4.0.0" },
  });
  await write("src/app.js", APP_JS);
  await write(".routelens/environments/local.env.json", {
    version: 1,
    name: "local",
    variables: { baseUrl },
  });
  await write(".routelens/environments/staging.env.json", {
    version: 1,
    name: "staging",
    variables: { baseUrl: "https://staging.example.com" },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relative: string, data: unknown): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

/** Fake "staging": real fetch for this machine, a canned answer for staging.example.com. */
const staged: string[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname.endsWith("example.com")) {
    staged.push(`${init?.method ?? "GET"} ${url.href}`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return fetch(input, init);
};

/** Connect a client the way an agent's app does. `answer`: the person's reply to questions. */
async function connect(
  options: Partial<RouteLensServerOptions> = {},
  answer?: "allow" | "deny",
): Promise<{
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  asked: string[];
  client: Client;
}> {
  const server = createServer({ root, fetch: fakeFetch, ...options });
  const client = new Client(
    { name: "test-agent", version: "1.0.0" },
    { capabilities: answer ? { elicitation: {} } : {} },
  );
  const asked: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return { action: "accept", content: { allow: answer === "allow" } };
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { call, asked, client };
}

const textOf = (result: CallToolResult, index = 0): string => {
  const item = result.content[index];
  return item?.type === "text" ? item.text : "";
};
const jsonOf = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>;

describe("tools", () => {
  it("offers seven tools, with hints about what they change", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_last_failure",
      "list_routes",
      "read_route_source",
      "run_all",
      "run_flow",
      "save_flow",
      "send_request",
    ]);
    const hints = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]),
    );
    expect(hints).toMatchObject({
      list_routes: true,
      read_route_source: true,
      get_last_failure: true,
      send_request: false,
    });
    expect(client.getInstructions()).toContain("list_routes");
  });

  it("list_routes: routes with their handler line, sample body and environment", async () => {
    const { call } = await connect();
    const result = jsonOf(await call("list_routes"));
    expect(result.environment).toEqual({
      name: "local",
      baseUrl,
      from: ".routelens/environments/local.env.json",
    });
    expect(result.routes).toEqual([
      { route: "GET /api/todos", source: "src/app.js:8", request: null },
      {
        route: "POST /api/todos",
        source: "src/app.js:10",
        request: null,
        sampleBody: { title: "example" },
        bodyFrom: "zod schema NewTodo (src/app.js:4)",
      },
      { route: "GET /api/todos/:id", source: "src/app.js:15", request: null },
      { route: "DELETE /api/todos/:id", source: "src/app.js:20", request: null },
    ]);
  });

  it("list_routes works on a project without .routelens, from the detected address", async () => {
    const fixture = fileURLToPath(new URL("../../../fixtures/express-routes", import.meta.url));
    // A copy without .routelens/: trying the fixture by hand creates one (ignored by Git).
    const copy = path.join(root, "express-routes");
    await cp(fixture, copy, {
      recursive: true,
      filter: (source) => !/[\\/]\.routelens([\\/]|$)/.test(source),
    });
    const { call } = await connect({ root: copy });
    const result = jsonOf(await call("list_routes"));
    expect((result.routes as unknown[]).length).toBe(14);
    expect(result.environment).toMatchObject({
      name: "local",
      from: expect.stringMatching(/^detected from /),
    });
  });

  it("read_route_source: the handler with line numbers and an arrow, and its zod schema", async () => {
    const { call } = await connect();
    const source = textOf(await call("read_route_source", { route: "POST /api/todos" }));
    expect(source).toContain("POST /api/todos · src/app.js:10 (express)");
    expect(source).toContain('→10 | app.post("/api/todos", (req, res) => {');
    expect(source).toContain("Body schema NewTodo · src/app.js:4");
    // A concrete URL path finds its route too.
    expect(textOf(await call("read_route_source", { route: "GET /api/todos/7" }))).toContain(
      "→15 |",
    );
    const missing = await call("read_route_source", { route: "GET /nope" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("Routes: GET /api/todos, POST /api/todos");
  });

  it("run_all, then get_last_failure: the failing route, what came back, and its code", async () => {
    const { call } = await connect();
    const all = jsonOf(await call("run_all"));
    expect(all).toMatchObject({ passed: 3, failed: 1 });
    expect(requests).toEqual([
      "GET /api/todos",
      "GET /api/todos/1",
      "POST /api/todos",
      "DELETE /api/todos/1",
    ]);
    expect(all.results).toContainEqual({
      name: "GET /api/todos/:id",
      kind: "route (sample request)",
      passed: false,
      result: expect.stringMatching(
        /^✗ 404 Not Found · \d+ ms · ✗ status is below 400: got 404 Not Found$/,
      ),
      route: "GET /api/todos/:id (src/app.js:15)",
    });

    const failure = await call("get_last_failure");
    const details = jsonOf(failure);
    expect(details).toMatchObject({
      failed: "GET /api/todos/:id",
      in: "run_all",
      sent: { method: "GET", url: `${baseUrl}/api/todos/1` },
      route: "GET /api/todos/:id (src/app.js:15)",
      checks: ["✗ status is below 400: got 404 Not Found"],
      response: { status: 404, body: { error: "Todo not found" } },
    });
    expect(textOf(failure, 1)).toContain('→15 | app.get("/api/todos/:id", (req, res) => {');
    expect(textOf(failure, 1)).toContain("todos.find((item) => item.id === req.params.id)");
  });

  it("send_request: by route with a new body, by URL, and explains bad input", async () => {
    const { call } = await connect();
    const created = jsonOf(
      await call("send_request", { route: "POST /api/todos", body: { title: "Ship M5" } }),
    );
    expect(created).toMatchObject({
      passed: true,
      route: "POST /api/todos (src/app.js:10)",
      response: { status: 201, body: { id: 1, title: "Ship M5" } },
    });
    const invalid = jsonOf(
      await call("send_request", {
        method: "POST",
        url: "{{baseUrl}}/api/todos",
        body: {},
        expect: { status: 400, body: { error: "title is required" } },
      }),
    );
    expect(invalid).toMatchObject({ passed: true, route: "POST /api/todos (src/app.js:10)" });
    expect(invalid.hint).toBeUndefined();
    // A passing send clears the failures.
    expect(jsonOf(await call("get_last_failure"))).toMatchObject({ failure: null });
    // Without expect, a 4xx fails the default check, so the agent is told how to expect it.
    const probe = jsonOf(await call("send_request", { route: "POST /api/todos", body: {} }));
    expect(probe).toMatchObject({
      passed: false,
      hint: 'If this 400 is what the API should answer, send again with expect: { "status": 400 } and it counts as passed.',
    });

    const both = await call("send_request", { route: "GET /api/todos", url: "/x" });
    expect(both.isError).toBe(true);
    const unknown = await call("send_request", { request: "nope" });
    expect(textOf(unknown)).toBe('No saved request "nope". Saved requests: none.');
  });

  it("says how to start the server when nothing answers, and never starts it", async () => {
    const closed = await new Promise<number>((resolve) => {
      const probe = createNetServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    await write("package.json", {
      name: "todos",
      scripts: { dev: "node src/app.js" },
      dependencies: { express: "5" },
    });
    await write(".routelens/environments/local.env.json", {
      version: 1,
      name: "local",
      variables: { baseUrl: `http://localhost:${closed}` },
    });
    const { call } = await connect();
    const result = await call("run_all");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      `Nothing answers on localhost:${closed}: the dev server is not running. RouteLens never starts it.`,
    );
    expect(textOf(result)).toContain("`npm run dev`");
  });
});

describe("guard rails", () => {
  it("refuses hosts that are not this machine or in an environment file", async () => {
    const { call } = await connect();
    const result = jsonOf(await call("send_request", { url: "https://evil.example.com/steal" }));
    expect(result).toMatchObject({ passed: false, error: { code: "blocked" } });
    expect(String((result.error as { message: string }).message)).toContain(
      "only sends to this machine and to hosts in the project's environment files (staging.example.com), so it did not send to evil.example.com",
    );
    expect(staged).not.toContain("GET https://evil.example.com/steal");
  });

  it("reads from an environment's host without asking", async () => {
    const { call, asked } = await connect({}, "deny");
    const result = jsonOf(
      await call("send_request", { route: "GET /api/todos", environment: "staging" }),
    );
    expect(result).toMatchObject({
      passed: true,
      request: "GET https://staging.example.com/api/todos",
    });
    expect(asked).toEqual([]);
  });

  it("asks the person once per host before writes there, and respects a no", async () => {
    const allowed = await connect({}, "allow");
    const run = jsonOf(await allowed.call("run_all", { environment: "staging" }));
    expect(run).toMatchObject({ passed: 4, failed: 0 });
    expect(allowed.asked).toHaveLength(1);
    expect(allowed.asked[0]).toContain(
      "An AI agent wants RouteLens to send POST https://staging.example.com/api/todos.",
    );

    const denied = await connect({}, "deny");
    const result = jsonOf(
      await denied.call("send_request", { route: "DELETE /api/todos/:id", environment: "staging" }),
    );
    expect(result).toMatchObject({
      passed: false,
      error: {
        code: "blocked",
        message: "The person said no to DELETE requests to staging.example.com.",
      },
    });
  });

  it("refuses writes elsewhere when the agent's app cannot ask, unless the person allowed them", async () => {
    const { call } = await connect();
    const result = jsonOf(
      await call("send_request", { route: "POST /api/todos", environment: "staging" }),
    );
    expect(String((result.error as { message: string }).message)).toContain(
      "needs a person's OK, and this AI app cannot ask for it",
    );

    const configured = await connect({ allowRemoteWrites: true });
    expect(
      jsonOf(
        await configured.call("send_request", { route: "POST /api/todos", environment: "staging" }),
      ),
    ).toMatchObject({
      passed: true,
    });
    const extraHost = await connect({ allowHosts: ["api.example.com"] });
    expect(
      jsonOf(await extraHost.call("send_request", { url: "https://api.example.com/health" })),
    ).toMatchObject({ passed: true });
  });

  it("logs in with the person's credentials from the server's environment, never from the agent", async () => {
    await write(
      "src/app.js",
      `const app = require("express")();\napp.post("/api/login", (req, res) => { const { email, password } = req.body; res.json({}); });\napp.get("/api/me", (req, res) => res.json({}));\n`,
    );
    const without = await connect();
    expect(jsonOf(await without.call("send_request", { route: "GET /api/me" }))).toMatchObject({
      passed: false,
    });
    const withLogin = await connect({ credentials: { username: "ada", password: "pw" } });
    expect(jsonOf(await withLogin.call("send_request", { route: "GET /api/me" }))).toMatchObject({
      passed: true,
      loggedIn: "RouteLens logged in first (auto-login).",
    });
  });
});

describe("flows", () => {
  const definition = {
    version: 1,
    name: "Create a todo and list them",
    steps: [
      {
        request: {
          method: "POST",
          url: "{{baseUrl}}/api/todos",
          body: { type: "json", content: { title: "x" } },
        },
        extract: { todoId: "body.id" },
      },
      {
        name: "List",
        request: { method: "GET", url: "{{baseUrl}}/api/todos" },
        expect: { status: 200, values: { "body.length": 0 } },
      },
    ],
  };

  it("run_flow tries a flow, save_flow saves it, and it runs again by name", async () => {
    const { call } = await connect();
    const tried = jsonOf(await call("run_flow", { definition }));
    expect(tried).toMatchObject({
      passed: true,
      steps: [
        { step: 1, passed: true, extracted: { todoId: 1 } },
        { step: 2, name: "List", passed: true },
      ],
    });

    expect(jsonOf(await call("save_flow", { name: "Create and list", definition }))).toEqual({
      saved: ".routelens/flows/create-and-list.flow.json",
      next: 'Run it with run_flow { "flow": "create-and-list" }.',
    });
    const saved = JSON.parse(
      await readFile(path.join(root, ".routelens/flows/create-and-list.flow.json"), "utf8"),
    );
    expect(saved).toEqual(definition);
    const again = await call("save_flow", { name: "Create and list", definition });
    expect(textOf(again)).toBe(
      ".routelens/flows/create-and-list.flow.json already exists. Pass overwrite: true to replace it.",
    );
    expect(
      (await call("save_flow", { name: "Create and list", definition, overwrite: true })).isError,
    ).toBeFalsy();

    expect(jsonOf(await call("run_flow", { flow: "create-and-list" }))).toMatchObject({
      passed: true,
    });
    expect(jsonOf(await call("list_routes")).flows).toEqual(["create-and-list"]);
  });

  it("explains an invalid flow, and reports a failing step with get_last_failure", async () => {
    const { call } = await connect();
    const invalid = await call("run_flow", {
      definition: { version: 1, name: "x", steps: [{ request: "a", expext: {} }] },
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain('steps.0: Unrecognized key: "expext"');
    expect((await call("save_flow", { name: "bad", definition: { version: 2 } })).isError).toBe(
      true,
    );

    const failing = jsonOf(
      await call("run_flow", {
        definition: {
          version: 1,
          name: "Read one",
          steps: [
            { name: "Read", request: { method: "GET", url: "{{baseUrl}}/api/todos/1" } },
            { request: "never-reached" },
          ],
        },
      }),
    );
    expect(failing).toMatchObject({ passed: false, notRun: ["never-reached"] });
    expect(jsonOf(await call("get_last_failure"))).toMatchObject({
      failed: "Read one › Read",
      in: 'flow "Read one", step 1',
      route: "GET /api/todos/:id (src/app.js:15)",
    });
  });
});
