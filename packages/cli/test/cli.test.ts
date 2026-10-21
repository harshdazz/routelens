import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isPortOpen } from "@routelens/core";
import { main, VERSION } from "../src/cli";
import { xml } from "../src/junit";

// The CLI runs in-process against a real local API, the way CI runs it.
let api: Server;
let baseUrl: string;
let port: number;
let project: string;

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
};

beforeAll(async () => {
  let nextId = 1;
  api = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const json = (status: number, data: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.method === "GET" && req.url === "/api/health") return json(200, { ok: true });
      if (req.method === "POST" && req.url === "/api/posts") {
        return typeof body.title === "string"
          ? json(201, { id: nextId++, title: body.title })
          : json(400, { error: "title is required" });
      }
      if (req.method === "GET" && req.url?.startsWith("/api/posts/")) {
        return json(200, { id: Number(req.url.split("/").at(-1)) });
      }
      if (req.method === "POST" && req.url === "/api/login") {
        return body.password === "pw" ? json(200, { token: "tok" }) : json(401, { error: "no" });
      }
      if (req.method === "GET" && req.url === "/api/me") {
        return req.headers.authorization === "Bearer tok" ? json(200, { me: 1 }) : json(401, {});
      }
      json(404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  port = (api.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "routelens-cli-"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function write(relative: string, data: unknown): Promise<void> {
  const file = path.join(project, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

const environment = (variables: Record<string, string>) =>
  write(".routelens/environments/local.env.json", { version: 1, name: "local", variables });

const request = (name: string, fields: Record<string, unknown>) =>
  write(`.routelens/requests/${name}.req.json`, { version: 1, name, method: "GET", ...fields });

async function cli(args: string[], env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    env,
    cwd: project,
  });
  return { code, stdout, stderr };
}

describe("routelens: arguments", () => {
  it("prints help and version, and rejects unknown commands", async () => {
    expect((await cli(["--help"])).stdout).toContain("Usage: routelens run [folder] [options]");
    expect(await cli(["-v"])).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    expect((await cli([])).code).toBe(2);
    expect(await cli(["test"])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Unknown command: test"),
    });
    expect((await cli(["run", "--only", "routes"])).stderr).toContain(
      '--only takes "requests" or "flows"',
    );
    expect((await cli(["run", "--var", "novalue"])).stderr).toContain("--var takes name=value");
  });

  it("says where it looked when there is no .routelens folder", async () => {
    const result = await cli(["run"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`No .routelens folder in ${project}`);
  });
});

describe("routelens run", () => {
  beforeEach(async () => {
    await environment({ baseUrl });
    await request("create-post", {
      method: "POST",
      url: "{{baseUrl}}/api/posts",
      body: { type: "json", content: { title: "Hello" } },
      expect: { status: 201, values: { "body.title": "Hello" } },
    });
    await request("health", { url: "{{baseUrl}}/api/health" });
    await write(".routelens/flows/create-and-read.flow.json", {
      version: 1,
      name: "Create and read",
      steps: [
        { request: "create-post", extract: { postId: "body.id" } },
        {
          request: { method: "GET", url: "{{baseUrl}}/api/posts/{{postId}}" },
          expect: { values: { "body.id": "{{postId}}" } },
        },
      ],
    });
  });

  it("runs requests (reads first) and flows, and exits 0 when everything passed", async () => {
    const result = await cli(["run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /Requests\n {2}✓ health · 200 OK · \d+ ms\n {2}✓ create-post · 201 Created · \d+ ms\n/,
    );
    expect(result.stdout).toMatch(/Flows\n {2}✓ Create and read · 2 steps · \d+ ms\n/);
    expect(result.stdout).toMatch(/\n3 passed · \d+ ms\n$/);
  });

  it("explains failures, exits 1 and writes a JUnit report", async () => {
    await request("broken-post", {
      method: "POST",
      url: "{{baseUrl}}/api/posts",
      body: { type: "json", content: {} },
    });
    await write(".routelens/requests/not-json.req.json", "{ nope");
    const result = await cli(["run", "--junit", "report.xml"], { GITHUB_ACTIONS: "true" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "  ✗ .routelens/requests/not-json.req.json\n      not-json.req.json is not valid JSON",
    );
    expect(result.stdout).toContain(`  ✗ broken-post · 400 Bad Request`);
    expect(result.stdout).toContain(
      `      .routelens/requests/broken-post.req.json · POST ${baseUrl}/api/posts\n      ✗ status is below 400: got 400 Bad Request\n`,
    );
    expect(result.stdout).toContain(
      "::error file=.routelens/requests/broken-post.req.json,title=RouteLens: broken-post::status is below 400: got 400 Bad Request",
    );
    expect(result.stdout).toMatch(/3 passed, 2 failed/);

    const report = await readFile(path.join(project, "report.xml"), "utf8");
    expect(report).toContain('<testsuites name="RouteLens" tests="6" failures="1" errors="1"');
    expect(report).toContain('<testsuite name="requests" tests="4" failures="1" errors="1"');
    expect(report).toContain(
      '<testsuite name="flow Create and read" tests="2" failures="0" errors="0"',
    );
    expect(report).toContain(
      '<failure message="status is below 400: got 400 Bad Request" type="check">',
    );
  });

  it("runs only requests or only flows", async () => {
    expect((await cli(["run", "--only", "flows"])).stdout).not.toContain("Requests\n");
    expect((await cli(["run", "--only", "requests"])).stdout).not.toContain("Flows\n");
  });

  it("takes variables from --var and ROUTELENS_VAR_, and refuses an unknown environment", async () => {
    await request("health", { url: "{{host}}/api/{{what}}" });
    const result = await cli(["run", "--only", "requests", "--var", "what=health"], {
      ROUTELENS_VAR_host: baseUrl,
    });
    expect(result.stdout).toContain("✓ health · 200 OK");
    expect(await cli(["run", "--env", "staging"])).toMatchObject({
      code: 2,
      stderr: 'No environment "staging" (.routelens/environments/staging.env.json).\n',
    });
  });

  it("logs in on a 401 with ROUTELENS_USERNAME and ROUTELENS_PASSWORD", async () => {
    await request("login", {
      method: "POST",
      url: "{{baseUrl}}/api/login",
      body: { type: "json", content: { email: "user@example.com", password: "example" } },
    });
    await request("me", { url: "{{baseUrl}}/api/me" });
    const without = await cli(["run", "--only", "requests"]);
    expect(without.code).toBe(1);
    expect(without.stdout).toContain(
      "Some routes answered 401. Set ROUTELENS_USERNAME and ROUTELENS_PASSWORD to log in with POST {{baseUrl}}/api/login.",
    );
    const withLogin = await cli(["run", "--only", "requests"], {
      ROUTELENS_USERNAME: "ada@example.com",
      ROUTELENS_PASSWORD: "pw",
    });
    expect(withLogin.code).toBe(0);
    expect(withLogin.stdout).toMatch(/✓ me · 200 OK · \d+ ms · logged in/);
    expect(withLogin.stdout).toMatch(/✓ login · 200 OK/);
  });
});

describe("routelens run: the server", () => {
  const freePort = async (): Promise<number> => {
    const server = createNetServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port: free } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return free;
  };

  it("stops with a clear message when nothing answers", async () => {
    const closed = await freePort();
    await environment({ baseUrl: `http://localhost:${closed}` });
    await request("health", { url: "{{baseUrl}}/api/health" });
    expect(await cli(["run"])).toMatchObject({
      code: 2,
      stderr: `Nothing answers on localhost:${closed}. Start your server first, or run with --start.\n`,
    });
  });

  it("starts the dev script with --start, runs, and stops it again", async () => {
    const free = await freePort();
    await write("package.json", { name: "app", private: true, scripts: { dev: "node server.js" } });
    await write(
      "server.js",
      `require("node:http").createServer((req, res) => res.end("ok")).listen(${free});\n`,
    );
    await environment({ baseUrl: `http://localhost:${free}` });
    await request("home", { url: "{{baseUrl}}/" });

    const result = await cli(["run", "--start", "--wait", "30"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Starting the dev server: npm run dev");
    expect(result.stdout).toContain("✓ home · 200 OK");
    expect(await isPortOpen(free)).toBe(false);
  }, 60_000);

  it("shows the server's last lines when it crashes before its port opens", async () => {
    const free = await freePort();
    await write("package.json", { name: "app", private: true, scripts: { dev: "node crash.js" } });
    await write("crash.js", 'console.error("Missing DATABASE_URL"); process.exit(3);\n');
    await environment({ baseUrl: `http://localhost:${free}` });
    await request("home", { url: "{{baseUrl}}/" });

    const result = await cli(["run", "--start"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/`npm run dev` exited with code \d+ before port \d+ opened\./);
    expect(result.stderr).toContain("  | Missing DATABASE_URL");
  }, 60_000);
});

describe("JUnit XML", () => {
  it("escapes markup and drops characters XML cannot hold", () => {
    expect(xml(`<a b="c">'&'\u0001`)).toBe("&lt;a b=&quot;c&quot;&gt;&apos;&amp;&apos;");
  });
});
