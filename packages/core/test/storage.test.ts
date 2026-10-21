import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectFiles,
  environmentFilePath,
  findProjectRoot,
  listEnvironments,
  listRequestFiles,
  normalizeBaseUrl,
  readEnvironment,
  readRequestFile,
  requestFilePath,
  setEnvironmentVariables,
  slugify,
  writeEnvironmentFile,
  writeRequestFile,
} from "../src/index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "routelens-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("request files", () => {
  it("round-trips a request through a file with stable formatting", async () => {
    const filePath = requestFilePath(root, "Create Post");
    await writeRequestFile(filePath, {
      version: 1,
      name: "Create Post",
      method: "POST",
      url: "{{baseUrl}}/api/posts",
      body: { type: "json", content: { title: "Hello" } },
    });

    expect(filePath).toBe(path.join(root, ".routelens", "requests", "create-post.req.json"));
    const text = await readFile(filePath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "version",
      "name",
      "method",
      "url",
      "headers",
      "query",
      "body",
    ]);

    const request = await readRequestFile(filePath);
    expect(request.body).toEqual({ type: "json", content: { title: "Hello" } });
  });

  it("lists request files in nested folders, sorted, ignoring other files", async () => {
    await writeRequestFile(requestFilePath(root, "b"), {
      version: 1,
      name: "b",
      method: "GET",
      url: "x",
    });
    const nested = path.join(root, ".routelens", "requests", "posts", "a.req.json");
    await writeRequestFile(nested, { version: 1, name: "a", method: "GET", url: "x" });
    await writeFile(path.join(root, ".routelens", "requests", "notes.md"), "hi");

    const files = await listRequestFiles(root);
    expect(files.map((file) => path.relative(root, file).split(path.sep).join("/"))).toEqual([
      ".routelens/requests/b.req.json",
      ".routelens/requests/posts/a.req.json",
    ]);
  });

  it("returns no files when there is no .routelens folder", async () => {
    expect(await listRequestFiles(root)).toEqual([]);
  });
});

describe("environments", () => {
  it("reads an environment by name", async () => {
    const dir = path.join(root, ".routelens", "environments");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "local.env.json"),
      JSON.stringify({
        version: 1,
        name: "local",
        variables: { baseUrl: "http://localhost:4000" },
      }),
    );
    expect((await readEnvironment(root, "local"))?.variables).toEqual({
      baseUrl: "http://localhost:4000",
    });
  });

  it("returns undefined for a missing environment", async () => {
    expect(await readEnvironment(root, "staging")).toBeUndefined();
  });

  it("lists environment names, sorted, ignoring other files", async () => {
    expect(await listEnvironments(root)).toEqual([]);
    await writeEnvironmentFile(root, { version: 1, name: "staging" });
    await writeEnvironmentFile(root, { version: 1, name: "local", variables: { a: "1" } });
    await writeFile(path.join(root, ".routelens", "environments", "README.md"), "hi");
    expect(await listEnvironments(root)).toEqual(["local", "staging"]);
  });

  it("writes stable JSON and sets variables without losing the others", async () => {
    const filePath = await writeEnvironmentFile(root, {
      version: 1,
      name: "local",
      variables: { baseUrl: "http://localhost:3000", postId: "1" },
    });
    expect(filePath).toBe(environmentFilePath(root, "local"));

    await setEnvironmentVariables(root, "local", { baseUrl: "http://localhost:3001" });
    const text = await readFile(filePath, "utf8");
    expect(text).toBe(
      '{\n  "version": 1,\n  "name": "local",\n  "variables": {\n' +
        '    "baseUrl": "http://localhost:3001",\n    "postId": "1"\n  }\n}\n',
    );
  });

  it("creates the environment file when setting a variable on a new environment", async () => {
    const environment = await setEnvironmentVariables(root, "staging", { baseUrl: "https://x" });
    expect(environment).toEqual({
      version: 1,
      name: "staging",
      variables: { baseUrl: "https://x" },
    });
    expect(await readEnvironment(root, "staging")).toEqual(environment);
  });
});

describe("normalizeBaseUrl", () => {
  it("keeps http(s) URLs and drops the trailing slash", () => {
    expect(normalizeBaseUrl(" http://localhost:3000/ ")).toBe("http://localhost:3000");
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });

  it("rejects anything else", () => {
    expect(normalizeBaseUrl("localhost:3000")).toBeUndefined();
    expect(normalizeBaseUrl("ftp://x")).toBeUndefined();
    expect(normalizeBaseUrl("")).toBeUndefined();
  });
});

describe("createProjectFiles", () => {
  it("creates local.env.json and a first request that uses {{baseUrl}}", async () => {
    const created = await createProjectFiles(root, "http://localhost:3000");
    expect(created.environmentFile).toBe(environmentFilePath(root, "local"));
    expect(created.requestFile).toBe(requestFilePath(root, "First request"));

    expect((await readEnvironment(root, "local"))?.variables).toEqual({
      baseUrl: "http://localhost:3000",
    });
    const request = await readRequestFile(created.requestFile!);
    expect(request).toMatchObject({ method: "GET", url: "{{baseUrl}}/", body: { type: "none" } });
  });

  it("never overwrites existing files", async () => {
    await writeEnvironmentFile(root, { version: 1, name: "local", variables: { baseUrl: "mine" } });
    await writeRequestFile(requestFilePath(root, "Mine"), {
      version: 1,
      name: "Mine",
      method: "GET",
      url: "x",
    });

    expect(await createProjectFiles(root, "http://localhost:3000")).toEqual({
      environmentFile: undefined,
      requestFile: undefined,
    });
    expect((await readEnvironment(root, "local"))?.variables).toEqual({ baseUrl: "mine" });
    expect(await listRequestFiles(root)).toHaveLength(1);
  });
});

describe("findProjectRoot", () => {
  it("walks up to the folder that contains .routelens", async () => {
    await mkdir(path.join(root, ".routelens"), { recursive: true });
    const deep = path.join(root, "src", "app", "api");
    await mkdir(deep, { recursive: true });
    expect(await findProjectRoot(deep)).toBe(root);
  });
});

describe("slugify", () => {
  it("makes safe file names", () => {
    expect(slugify("Create Post (v2)!")).toBe("create-post-v2");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("???")).toBe("request");
  });
});
