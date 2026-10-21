import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthSession,
  RouteLensError,
  findLoginRequest,
  flowFilePath,
  orderForRun,
  parseFlow,
  parseRequest,
  readRequestFile,
  requestFilePath,
  runFlow,
  runRequest,
  writeFlowFile,
  writeRequestFile,
  type ApiRequest,
  type ApiRequestInput,
  type Credentials,
  type FlowInput,
} from "../src/index.js";

// A small API with a login: the runner is tested against real HTTP, like the CLI uses it.
let server: Server;
let baseUrl: string;
let logins = 0;
let validTokens = new Set<string>();
const posts = new Map<number, { id: number; title: string }>();

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : undefined;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, data: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(data));
      };
      const body = (await readBody(req)) as Record<string, unknown> | undefined;
      const url = req.url ?? "/";
      if (req.method === "POST" && url === "/api/auth/login") {
        if (body?.email === "ada@example.com" && body.password === "s3cret") {
          logins += 1;
          const token = `tok-${logins}`;
          validTokens.add(token);
          return json(200, { data: { user: { email: body.email }, accessToken: token } });
        }
        return json(401, { error: "wrong email or password" });
      }
      if (req.method === "POST" && url === "/api/session") {
        res.writeHead(204, {
          "Set-Cookie": [
            "sid=abc; Path=/; HttpOnly",
            "theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
          ],
        });
        return res.end();
      }
      if (req.method === "GET" && url === "/api/me") {
        const token = req.headers.authorization?.replace(/^Bearer /, "");
        return token && validTokens.has(token)
          ? json(200, { email: "ada@example.com" })
          : json(401, { error: "log in first" });
      }
      if (req.method === "GET" && url === "/api/cookie-me") {
        return req.headers.cookie === "sid=abc; theme=dark"
          ? json(200, { ok: true })
          : json(401, { error: "no session" });
      }
      if (req.method === "POST" && url === "/api/posts") {
        if (typeof body?.title !== "string") return json(400, { error: "title is required" });
        const post = { id: posts.size + 1, title: body.title };
        posts.set(post.id, post);
        return json(201, post);
      }
      const match = /^\/api\/posts\/(\d+)$/.exec(url);
      if (req.method === "GET" && match) {
        const post = posts.get(Number(match[1]));
        return post ? json(200, post) : json(404, { error: "not found" });
      }
      json(404, { error: `no route ${req.method} ${url}` });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  logins = 0;
  validTokens = new Set();
  posts.clear();
});

const request = (fields: Partial<ApiRequestInput> & Pick<ApiRequestInput, "url">): ApiRequest =>
  parseRequest(JSON.stringify({ version: 1, name: "test", method: "GET", ...fields }));

const loginRequest = request({
  name: "Log in",
  method: "POST",
  url: "{{baseUrl}}/api/auth/login",
  body: { type: "json", content: { email: "user@example.com", password: "example" } },
});

/** `null`: the person gives no credentials. */
const session = (
  credentials: Credentials | null = { username: "ada@example.com", password: "s3cret" },
) => {
  const login = findLoginRequest([{ file: "/x/login.req.json", request: loginRequest }]);
  if (!login) throw new Error("no login request found");
  const asked: boolean[] = [];
  const auth = new AuthSession(login, async (ask) => {
    asked.push(ask);
    return credentials ?? undefined;
  });
  return { auth, asked };
};

describe("runRequest", () => {
  it("passes when the status is below 400, without an expect block", async () => {
    const run = await runRequest(request({ url: "{{baseUrl}}/api/posts/7" }), {
      variables: { baseUrl },
    });
    expect(run).toMatchObject({
      url: `${baseUrl}/api/posts/7`,
      passed: false,
      checks: [{ label: "status is below 400", passed: false, detail: "got 404 Not Found" }],
    });
  });

  it("checks the request's expect block", async () => {
    const run = await runRequest(
      request({
        method: "POST",
        url: "{{baseUrl}}/api/posts",
        body: { type: "json", content: {} },
        expect: { status: 400, body: { error: "title is required" } },
      }),
      { variables: { baseUrl } },
    );
    expect(run.passed).toBe(true);
    expect(run.checks.map((item) => item.label)).toEqual([
      "status is 400",
      'body contains {"error":"title is required"}',
    ]);
  });

  it("does not send when a variable is missing, unless asked to", async () => {
    const run = await runRequest(request({ url: "{{baseUrl}}/api/posts/{{postId}}" }), {
      variables: { baseUrl },
    });
    expect(run).toMatchObject({
      passed: false,
      error: { code: "invalid-request", message: "{{postId}} not defined." },
    });
    expect(run.response).toBeUndefined();
  });

  it("reports a server that is not running as a failed run", async () => {
    const run = await runRequest(request({ url: "http://127.0.0.1:1/api" }), { variables: {} });
    expect(run).toMatchObject({ passed: false, error: { code: "network" } });
  });

  it("throws when the run is cancelled, so a batch stops", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runRequest(request({ url: `${baseUrl}/api/me` }), {
        variables: {},
        send: { signal: controller.signal },
      }),
    ).rejects.toMatchObject({ code: "aborted" } satisfies Partial<RouteLensError>);
  });
});

describe("auto-login", () => {
  const me = request({ name: "Me", url: "{{baseUrl}}/api/me" });

  it("finds the login request: a POST to a login path with a password field", () => {
    const create = request({
      method: "POST",
      url: "{{baseUrl}}/api/posts",
      body: { type: "json", content: { title: "x" } },
    });
    const token = request({
      method: "POST",
      url: "{{baseUrl}}/api/token",
      body: { type: "json", content: { password: "x" } },
    });
    const noPassword = request({
      method: "POST",
      url: "{{baseUrl}}/api/login",
      body: { type: "json", content: { email: "x" } },
    });
    expect(
      findLoginRequest([
        { request: create },
        { request: token },
        { request: noPassword },
        { request: loginRequest },
      ]),
    ).toMatchObject({
      request: { url: "{{baseUrl}}/api/auth/login" },
      usernameField: "email",
      passwordField: "password",
    });
    expect(findLoginRequest([{ request: create }, { request: noPassword }])).toBeUndefined();
    const fromRoute = request({
      method: "POST",
      url: "{{baseUrl}}/api/x",
      body: { type: "form", content: { username: "", pwd: "" } },
      route: { key: "POST /api/sign-in" },
    });
    expect(findLoginRequest([{ request: fromRoute }])).toMatchObject({
      usernameField: "username",
      passwordField: "pwd",
    });
  });

  it("logs in on a 401, sends again with the token and reuses it", async () => {
    const { auth, asked } = session();
    const first = await runRequest(me, { variables: { baseUrl }, auth });
    expect(first).toMatchObject({ passed: true, loggedIn: true, response: { status: 200 } });
    const second = await runRequest(me, { variables: { baseUrl }, auth });
    expect(second).toMatchObject({ passed: true, loggedIn: false });
    expect(logins).toBe(1);
    expect(asked).toEqual([true]);
  });

  it("logs in again once when the token expired", async () => {
    const { auth } = session();
    await runRequest(me, { variables: { baseUrl }, auth });
    validTokens.clear();
    const run = await runRequest(me, { variables: { baseUrl }, auth });
    expect(run).toMatchObject({ passed: true, loggedIn: true });
    expect(logins).toBe(2);
  });

  it("explains a failed login and stops trying until the failure is cleared", async () => {
    const { auth, asked } = session({ username: "ada@example.com", password: "wrong" });
    const run = await runRequest(me, { variables: { baseUrl }, auth });
    expect(run.passed).toBe(false);
    expect(run.checks.at(-1)).toEqual({
      label: "logged in",
      passed: false,
      detail: "Login failed: POST /api/auth/login answered 401.",
    });
    await runRequest(me, { variables: { baseUrl }, auth });
    expect(asked).toHaveLength(1);
    auth.clearFailure();
    await runRequest(me, { variables: { baseUrl }, auth });
    expect(asked).toHaveLength(2);
  });

  it("never logs in for a request that expects the 401", async () => {
    const { auth, asked } = session();
    const run = await runRequest(
      { ...me, expect: { status: 401 } },
      { variables: { baseUrl }, auth },
    );
    expect(run).toMatchObject({ passed: true, loggedIn: false });
    expect(asked).toEqual([]);
  });

  it("runs the login request with the person's credentials, without asking", async () => {
    const { auth, asked } = session();
    const run = await runRequest(loginRequest, {
      variables: { baseUrl },
      auth,
      file: "/x/login.req.json",
    });
    expect(run).toMatchObject({ passed: true, loggedIn: true });
    expect(asked).toEqual([false]);
    expect(auth.loggedIn).toBe(true);
  });

  it("sends the login request as written when there are no credentials", async () => {
    const { auth } = session(null);
    const run = await runRequest(loginRequest, {
      variables: { baseUrl },
      auth,
      file: "/x/login.req.json",
    });
    expect(run).toMatchObject({ passed: false, loggedIn: false, response: { status: 401 } });
    expect(auth.failure).toBeUndefined(); // not asking is not a failure
  });

  it("uses the cookies of a login that sets them", async () => {
    const cookieLogin = findLoginRequest([
      {
        request: request({
          method: "POST",
          url: "{{baseUrl}}/api/session",
          body: { type: "json", content: { username: "", password: "" } },
        }),
      },
    ]);
    if (!cookieLogin) throw new Error("no login");
    const auth = new AuthSession(cookieLogin, async () => ({ username: "ada", password: "x" }));
    const run = await runRequest(request({ url: "{{baseUrl}}/api/cookie-me" }), {
      variables: { baseUrl },
      auth,
    });
    expect(run).toMatchObject({ passed: true, loggedIn: true });
  });

  it("never sends the token to another server", async () => {
    const { auth } = session();
    await runRequest(me, { variables: { baseUrl }, auth });
    const other = auth.apply({ method: "GET", url: "http://example.com/api/me", headers: {} });
    expect(other.headers).toEqual({});
    const own = auth.apply({
      method: "GET",
      url: `${baseUrl}/api/me`,
      headers: { authorization: "Bearer mine" },
    });
    expect(own.headers).toEqual({ authorization: "Bearer mine" });
  });
});

describe("runFlow", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "routelens-flow-"));
    await writeRequestFile(requestFilePath(root, "create-post"), {
      version: 1,
      name: "Create post",
      method: "POST",
      url: "{{baseUrl}}/api/posts",
      body: { type: "json", content: { title: "{{title}}" } },
      expect: { status: 201 },
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const flow = (input: Omit<FlowInput, "version" | "name">) =>
    parseFlow(JSON.stringify({ version: 1, name: "Posts", ...input }));

  it("runs saved and inline steps in order, passing extracted values on with their type", async () => {
    const result = await runFlow(
      flow({
        variables: { title: "Hello" },
        steps: [
          { request: "create-post", extract: { postId: "body.id" } },
          {
            name: "Read it",
            request: { method: "GET", url: "{{baseUrl}}/api/posts/{{postId}}" },
            expect: {
              status: 200,
              values: { "body.id": "{{postId}}", "body.title": { contains: "ell" } },
            },
          },
        ],
      }),
      { root, variables: { baseUrl } },
    );
    expect(result.passed).toBe(true);
    expect(result.steps.map((step) => [step.name, step.passed])).toEqual([
      ["Create post", true],
      ["Read it", true],
    ]);
    expect(result.steps[0]?.extracted).toEqual({ postId: 1 });
    expect(result.steps[1]?.checks.map((check) => check.label)).toEqual([
      "status is 200",
      "body.id is 1",
      'body.title contains "ell"',
    ]);
  });

  it("stops at the first failing step and lists the steps it skipped", async () => {
    const steps: string[] = [];
    const result = await runFlow(
      flow({
        steps: [
          { request: { method: "GET", url: "{{baseUrl}}/api/posts/99" }, expect: { status: 200 } },
          { name: "Never", request: { method: "GET", url: "{{baseUrl}}/api/me" } },
          { request: "create-post" },
        ],
      }),
      { root, variables: { baseUrl }, onStep: (step) => steps.push(step.name) },
    );
    expect(result).toMatchObject({ passed: false, skipped: ["Never", "create-post"] });
    expect(steps).toEqual(["GET {{baseUrl}}/api/posts/99"]);
    expect(result.steps[0]?.checks[0]).toEqual({
      label: "status is 200",
      passed: false,
      detail: "got 404 Not Found",
    });
  });

  it("fails a step whose saved request is missing or whose extract path is missing", async () => {
    const missing = await runFlow(flow({ steps: [{ request: "nope" }] }), {
      root,
      variables: { baseUrl },
    });
    expect(missing.steps[0]?.error?.message).toBe(
      'No saved request named "nope" (.routelens/requests/nope.req.json).',
    );
    const outside = await runFlow(flow({ steps: [{ request: "../../etc/passwd" }] }), {
      root,
      variables: {},
    });
    expect(outside.steps[0]?.error?.message).toBe(
      '"../../etc/passwd" is not a request in .routelens/requests.',
    );

    const noValue = await runFlow(
      flow({
        variables: { title: "x" },
        steps: [{ request: "create-post", extract: { slug: "body.slug" } }],
      }),
      { root, variables: { baseUrl } },
    );
    expect(noValue.passed).toBe(false);
    expect(noValue.steps[0]?.checks.at(-1)).toEqual({
      label: "save body.slug as {{slug}}",
      passed: false,
      detail: "body.slug is missing",
    });
  });

  it("logs in when a step gets a 401", async () => {
    const { auth } = session();
    const result = await runFlow(
      flow({ steps: [{ request: { method: "GET", url: "{{baseUrl}}/api/me" } }] }),
      {
        root,
        variables: { baseUrl },
        auth,
      },
    );
    expect(result.steps[0]).toMatchObject({ passed: true, loggedIn: true });
  });
});

describe("request files with expect", () => {
  it("keep their expect block when written and read again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "routelens-expect-"));
    try {
      const file = requestFilePath(root, "x");
      await writeRequestFile(file, {
        version: 1,
        name: "x",
        method: "GET",
        url: "{{baseUrl}}/",
        expect: { status: "2xx", values: { "body.ok": true } },
      });
      expect((await readRequestFile(file)).expect).toEqual({
        status: "2xx",
        values: { "body.ok": true },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("orderForRun", () => {
  it("runs reads first, then writes, and deletes last", () => {
    const items = ["DELETE a", "POST b", "GET c", "PATCH d", "GET e", "PUT f", "HEAD g"].map(
      (text) => {
        const [method = "GET", name = ""] = text.split(" ");
        return { method: method as ApiRequest["method"], name };
      },
    );
    expect(orderForRun(items).map((item) => item.name)).toEqual([
      "c",
      "e",
      "g",
      "b",
      "f",
      "d",
      "a",
    ]);
  });
});

describe("beforeSend", () => {
  it("checks every request just before it goes out, and a refusal fails the run as blocked", async () => {
    const seen: string[] = [];
    const run = await runRequest(
      request({
        method: "POST",
        url: "{{baseUrl}}/api/posts",
        body: { type: "json", content: { title: "x" } },
      }),
      {
        variables: { baseUrl },
        beforeSend: async (target) => {
          seen.push(`${target.method} ${target.url}`);
          throw new RouteLensError("blocked", "Not this time.");
        },
      },
    );
    expect(seen).toEqual([`POST ${baseUrl}/api/posts`]);
    expect(run).toMatchObject({
      passed: false,
      error: { code: "blocked", message: "Not this time." },
    });
    expect(run.response).toBeUndefined();
    expect(posts.size).toBe(0);
  });

  it("also sees the retry after a login, and the login request itself", async () => {
    const { auth } = session();
    const seen: string[] = [];
    const beforeSend = async (target: { method: string; url: string }) => {
      seen.push(`${target.method} ${new URL(target.url).pathname}`);
    };
    await runRequest(request({ url: "{{baseUrl}}/api/me" }), {
      variables: { baseUrl },
      auth,
      beforeSend,
    });
    await runRequest(loginRequest, {
      variables: { baseUrl },
      auth,
      beforeSend,
      file: "/x/login.req.json",
    });
    expect(seen).toEqual(["GET /api/me", "GET /api/me", "POST /api/auth/login"]);
  });
});

describe("flow files", () => {
  it("are written in a stable order and read back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "routelens-flowfile-"));
    try {
      const file = flowFilePath(root, "Create & read!");
      expect(path.relative(root, file)).toBe(
        path.join(".routelens", "flows", "create-read.flow.json"),
      );
      await writeFlowFile(file, {
        steps: [{ request: "create-post" }],
        variables: {},
        name: "Create & read",
        version: 1,
      });
      const text = await readFile(file, "utf8");
      expect(text).toBe(
        '{\n  "version": 1,\n  "name": "Create & read",\n  "steps": [\n    {\n      "request": "create-post"\n    }\n  ]\n}\n',
      );
      expect(parseFlow(text).steps[0]?.request).toBe("create-post");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
