import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeClue,
  detectPackageManager,
  detectServer,
  listWorkspacePackages,
  parsePnpmWorkspace,
  readPackageJson,
  type ServerDetection,
} from "../src/index.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));
/** Fixture tests must not depend on what happens to run on this machine. */
const nothingRunning = async () => false;

describe("detectServer on the fixtures", () => {
  const detect = async (name: string): Promise<ServerDetection> => {
    const result = await detectServer(fixture(name), { isPortOpen: nothingRunning });
    if (!result) throw new Error(`no package.json in ${name}`);
    return result;
  };

  it("next-default: port 3000 from `next dev`, npm from package-lock.json", async () => {
    const result = await detect("next-default");
    expect(result.address?.baseUrl).toBe("http://localhost:3000");
    expect(result.address?.clue.kind).toBe("tool-default");
    expect(describeClue(result.address!)).toBe(
      '"next dev" in package.json: Next.js uses port 3000',
    );
    expect(result.start).toEqual({
      packageManager: "npm",
      packageManagerClue: "package-lock.json",
      script: "dev",
      command: "npm run dev",
      cwd: fixture("next-default"),
    });
  });

  it("next-port: port 3001 from the -p flag, yarn from yarn.lock", async () => {
    const result = await detect("next-port");
    expect(result.address?.port).toBe(3001);
    expect(describeClue(result.address!)).toBe('"next dev -p 3001" in package.json');
    // The tool default is still offered by the Change button.
    expect(result.candidates.map((candidate) => candidate.port)).toEqual([3001, 3000]);
    expect(result.start?.command).toBe("yarn run dev");
  });

  it("vite: port 5173 from `vite`, bun from bun.lock", async () => {
    const result = await detect("vite");
    expect(result.address?.port).toBe(5173);
    expect(result.start?.command).toBe("bun run dev");
  });

  it("express-env: PORT in .env beats the fallback in server.js, and `start` is used", async () => {
    const result = await detect("express-env");
    expect(result.address?.port).toBe(4100);
    expect(describeClue(result.address!)).toBe("PORT in .env");
    expect(result.candidates[1]).toMatchObject({
      port: 3000,
      clue: { kind: "code", file: "server.js", line: 11 },
    });
    expect(result.start?.script).toBe("start");
    expect(result.start?.command).toBe("pnpm run start");
  });

  it("monorepo: picks apps/api, reads listen() there, uses the root pnpm lockfile", async () => {
    const result = await detect("monorepo");
    expect(result.serverDir).toBe(path.join(fixture("monorepo"), "apps", "api"));
    expect(result.address?.port).toBe(8080);
    expect(describeClue(result.address!)).toBe("listen() in apps/api/src/server.js:10");
    expect(result.start).toMatchObject({
      packageManager: "pnpm",
      packageManagerClue: "pnpm-lock.yaml",
      command: "pnpm run dev",
      cwd: path.join(fixture("monorepo"), "apps", "api"),
    });
  });

  it("lists the monorepo packages from pnpm-workspace.yaml", async () => {
    const root = fixture("monorepo");
    const pkg = await readPackageJson(root);
    expect(await listWorkspacePackages(root, pkg!)).toEqual([
      path.join(root, "apps", "api"),
      path.join(root, "apps", "web"),
    ]);
  });
});

describe("detectServer ranking", () => {
  let root: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "routelens-detect-"));
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    await rm(root, { recursive: true, force: true });
  });

  const write = async (file: string, content: string | object) => {
    const filePath = path.join(root, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      typeof content === "string" ? content : JSON.stringify(content),
      "utf8",
    );
  };

  it("returns undefined without a package.json", async () => {
    expect(await detectServer(root)).toBeUndefined();
  });

  it("prefers a port that is already open (the server is running)", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const openPort = (server.address() as { port: number }).port;

    await write("package.json", { scripts: { dev: "node server.js --port 1" } });
    await write(".env", `PORT=${openPort}\n`);
    await write("server.js", "app.listen(65000);");

    const result = await detectServer(root);
    expect(result?.address).toMatchObject({ port: openPort, running: true });
    expect(describeClue(result!.address!)).toBe("PORT in .env, running now");
  });

  it("a port flag in the script beats .env", async () => {
    await write("package.json", { scripts: { dev: "node server.js --port 5001" } });
    await write(".env", "PORT=5002\n");
    const result = await detectServer(root, { isPortOpen: nothingRunning });
    expect(result?.candidates.map((candidate) => candidate.port)).toEqual([5001, 5002]);
  });

  it(".env.local overrides .env", async () => {
    await write("package.json", { scripts: { start: "node server.js" } });
    await write(".env", "PORT=5003\n");
    await write(".env.local", "# local\nPORT=5004\n");
    const result = await detectServer(root, { isPortOpen: nothingRunning });
    expect(describeClue(result!.address!)).toBe("PORT in .env.local");
  });

  it("Next.js ignores PORT in .env, so its default comes first", async () => {
    await write("package.json", { scripts: { dev: "next dev" } });
    await write(".env", "PORT=5005\n");
    const result = await detectServer(root, { isPortOpen: nothingRunning });
    expect(result?.candidates.map((candidate) => candidate.port)).toEqual([3000, 5005]);
  });

  it("reads listen() in package.json `main` when the script names no file", async () => {
    await write("package.json", { main: "lib/entry.js", scripts: { dev: "nodemon" } });
    await write("lib/entry.js", "const app = express();\napp.listen(5006);\n");
    const result = await detectServer(root, { isPortOpen: nothingRunning });
    expect(describeClue(result!.address!)).toBe("listen() in lib/entry.js:2");
  });

  it("finds no address and no start command in a library with no clues", async () => {
    await write("package.json", { scripts: { build: "tsc", test: "vitest" } });
    const result = await detectServer(root, { isPortOpen: nothingRunning });
    expect(result).toEqual({
      serverDir: root,
      address: undefined,
      candidates: [],
      start: undefined,
    });
  });

  it("uses the root package when no workspace package can be started", async () => {
    await write("package.json", { workspaces: ["packages/*"], scripts: { dev: "vite" } });
    await write("packages/lib/package.json", { name: "lib", scripts: { build: "tsc" } });
    const result = await detectServer(root, { isPortOpen: nothingRunning });
    expect(result?.serverDir).toBe(root);
    expect(result?.address?.port).toBe(5173);
  });

  it("throws a friendly error for a broken package.json", async () => {
    await write("package.json", "{ not json");
    await expect(detectServer(root)).rejects.toMatchObject({ code: "invalid-file" });
  });
});

describe("detectPackageManager", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "routelens-pm-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ])("%s → %s", async (lockfile, expected) => {
    await writeFile(path.join(root, lockfile), "", "utf8");
    expect(await detectPackageManager(root, root)).toEqual({ name: expected, clue: lockfile });
  });

  it('prefers Corepack\'s "packageManager" field over a lockfile', async () => {
    await writeFile(path.join(root, "package.json"), '{"packageManager":"pnpm@10.16.1"}', "utf8");
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    expect(await detectPackageManager(root, root)).toEqual({
      name: "pnpm",
      clue: '"packageManager" in package.json',
    });
  });

  it("defaults to npm, and never looks above the workspace folder", async () => {
    // A stray lockfile above the project (e.g. in the home folder) must be ignored.
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(root, "yarn.lock"), "", "utf8");
    expect(await detectPackageManager(project, project)).toEqual({ name: "npm", clue: "default" });
  });

  it("looks above the workspace folder up to the Git repository root", async () => {
    const app = path.join(root, "apps", "api");
    await mkdir(app, { recursive: true });
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, "pnpm-lock.yaml"), "", "utf8");
    expect(await detectPackageManager(app, app)).toEqual({
      name: "pnpm",
      clue: "pnpm-lock.yaml",
    });
  });
});

describe("parsePnpmWorkspace", () => {
  it("reads block and inline lists, quoted or not, and skips other keys", () => {
    expect(
      parsePnpmWorkspace(
        "packages:\n  - 'apps/*'\n  - packages/ui # comment\n  - \"!**/test\"\ncatalog:\n  - nope\n",
      ),
    ).toEqual(["apps/*", "packages/ui", "!**/test"]);
    expect(parsePnpmWorkspace('packages: ["apps/*", services/api]')).toEqual([
      "apps/*",
      "services/api",
    ]);
    expect(parsePnpmWorkspace("")).toEqual([]);
  });
});
