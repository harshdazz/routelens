// Runs the extension tests (test/e2e/suite) inside a real VS Code, downloaded into .vscode-test/.
//
//   pnpm test:e2e          extension tests on a tiny generated project (runs in CI;
//                          on Linux: xvfb-run -a pnpm test:e2e)
//   pnpm test:acceptance   the M2 acceptance check on a fresh copy of fixtures/next-default
//                          (runs `npm ci` first, needs the internet and port 3000 free)
import { execSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const suite = process.argv[2] ?? "extension";
const extensionDevelopmentPath = fileURLToPath(new URL("../..", import.meta.url));
const extensionTestsPath = path.join(extensionDevelopmentPath, "out", "e2e", "suite", "index.js");
const repoRoot = path.resolve(extensionDevelopmentPath, "..", "..");

/** A port that is free right now, so the test server never clashes with something running. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "localhost", port, autoSelectFamily: true });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => (socket.destroy(), resolve(false)));
  });
}

/**
 * A fresh project with no .routelens/ folder: a package.json with a `dev` script and a tiny
 * server with no dependencies. RouteLens must find `listen(<port>)` by itself.
 * routes.js and auth.js are Express code that is never run: RouteLens only reads them (M3).
 * The tiny server answers every path (with a request counter `n`, so a run can be told from
 * the one before), except /api/me, which needs the token from POST /api/login (M4).
 */
async function tinyProject(workspace) {
  const port = await freePort();
  const pkg = {
    name: "e2e-app",
    private: true,
    scripts: { dev: "node server.js" },
    dependencies: { express: "^5.1.0", zod: "^4.6.7" },
  };
  await writeFile(path.join(workspace, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(
    path.join(workspace, "routes.js"),
    [
      'const express = require("express");',
      'const { z } = require("zod");',
      "",
      "const Item = z.object({",
      "  name: z.string().min(2),",
      "  qty: z.number().int().positive(),",
      "});",
      "",
      "const app = express();",
      "",
      'app.get("/api/health", (req, res) => res.json({ ok: true }));',
      "",
      'app.post("/api/items", (req, res) => {',
      "  const item = Item.parse(req.body);",
      "  res.status(201).json(item);",
      "});",
      "",
      "module.exports = app;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(workspace, "auth.js"),
    [
      'const express = require("express");',
      'const { z } = require("zod");',
      "",
      "const Login = z.object({ email: z.string().email(), password: z.string().min(8) });",
      "const app = express();",
      'app.post("/api/login", (req, res) => res.json({ token: Login.parse(req.body).email }));',
      'app.get("/api/me", (req, res) => res.json({ me: true }));',
      "module.exports = app;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(workspace, "server.js"),
    [
      'const http = require("node:http");',
      "let n = 0;",
      "const tokens = new Set();",
      "const server = http.createServer((req, res) => {",
      '  let raw = "";',
      '  req.on("data", (chunk) => (raw += chunk));',
      '  req.on("end", () => {',
      "    n += 1;",
      "    const send = (status, data) => {",
      '      res.writeHead(status, { "Content-Type": "application/json" });',
      "      res.end(JSON.stringify(data));",
      "    };",
      '    if (req.method === "POST" && req.url === "/api/login") {',
      '      const body = JSON.parse(raw || "{}");',
      '      if (body.password !== "e2e-password") return send(401, { error: "wrong password" });',
      "      const token = `t${n}`;",
      "      tokens.add(token);",
      "      return send(200, { data: { token } });",
      "    }",
      '    if (req.url === "/api/me") {',
      '      const token = (req.headers.authorization || "").replace("Bearer ", "");',
      '      return tokens.has(token) ? send(200, { me: "e2e" }) : send(401, { error: "log in" });',
      "    }",
      "    send(200, { ok: true, path: req.url, n });",
      "  });",
      "});",
      `server.listen(${port}, () => console.log("e2e server ready"));`,
      "",
    ].join("\n"),
  );
  return { ROUTELENS_E2E_PORT: String(port) };
}

/** A fresh copy of the Next.js fixture with its dependencies installed, like a real project. */
async function nextProject(workspace) {
  if (await isPortOpen(3000)) {
    throw new Error("Port 3000 is in use. Stop whatever runs there, then try again.");
  }
  await cp(path.join(repoRoot, "fixtures", "next-default"), workspace, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|\.next|\.routelens)([\\/]|$)/.test(source),
  });
  console.log(`Installing the Next.js fixture in ${workspace} (npm ci)...`);
  execSync("npm ci --no-audit --no-fund", { cwd: workspace, stdio: "inherit" });
  return {};
}

const workspace = await mkdtemp(path.join(tmpdir(), `routelens-${suite}-`));
try {
  const env = suite === "acceptance" ? await nextProject(workspace) : await tinyProject(workspace);
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? "stable",
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      // Same reason as in .vscode/launch.json: only RouteLens is loaded.
      "--disable-extensions",
      // The temporary folder counts as trusted, like a project the user trusts.
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
    extensionTestsEnv: { ROUTELENS_E2E_SUITE: suite, ROUTELENS_E2E_WORKSPACE: workspace, ...env },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // A dev server may still hold files for a moment on Windows.
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() =>
    console.warn(`Could not delete ${workspace}; delete it by hand.`),
  );
}
