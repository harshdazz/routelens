import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The bundled server, started the way agents start it: a child process speaking MCP on stdio.
// Built here with the same settings as esbuild.mjs, into out/ (next to node_modules, so the
// bundle finds TypeScript the way the published package does).
const bundle = fileURLToPath(new URL("../out/routelens-mcp.cjs", import.meta.url));
const fixture = fileURLToPath(new URL("../../../fixtures/express-routes", import.meta.url));
let client: Client;

beforeAll(async () => {
  await esbuild.build({
    entryPoints: [fileURLToPath(new URL("../src/bin.ts", import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["typescript"],
    conditions: ["source"],
    logLevel: "silent",
  });
  client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bundle, "--root", fixture],
      stderr: "ignore",
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("routelens-mcp over stdio", () => {
  it("starts, lists its tools and reads the fixture's routes", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(7);
    const result = await client.callTool({ name: "list_routes", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const routes = (JSON.parse(content[0]?.text ?? "{}") as { routes: Array<{ route: string }> })
      .routes;
    expect(routes.map((route) => route.route)).toContain("POST /api/users");
    expect(routes).toHaveLength(14);
  });
});
