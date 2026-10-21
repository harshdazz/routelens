import { describe, expect, it } from "vitest";
import { findListenPort, parseScript, pickStartScript } from "../src/index.js";

describe("pickStartScript", () => {
  it("prefers dev, then start, and ignores everything else", () => {
    expect(pickStartScript({ dev: "next dev", start: "next start" })).toEqual({
      name: "dev",
      command: "next dev",
    });
    expect(pickStartScript({ start: "node server.js", build: "tsc" })?.name).toBe("start");
    expect(pickStartScript({ build: "tsc", serve: "node x.js" })).toBeUndefined();
    expect(pickStartScript({ dev: "  " })).toBeUndefined();
    expect(pickStartScript(undefined)).toBeUndefined();
  });
});

describe("parseScript", () => {
  it.each([
    ["next dev", undefined, "next", 3000],
    ["next dev -p 3001", 3001, "next", 3000],
    ["next dev --port 3002", 3002, "next", 3000],
    ["next dev --port=3003 --turbopack", 3003, "next", 3000],
    ["next start -p=3004", 3004, "next", 3000],
    ["./node_modules/.bin/next dev", undefined, "next", 3000],
    ["next build && next start", undefined, "next", 3000],
    ["vite", undefined, "vite", 5173],
    ["vite --port 5200", 5200, "vite", 5173],
    ["vite preview", undefined, "vite", 4173],
    ["nest start --watch", undefined, "nest", 3000],
    ["PORT=4000 node server.js", 4000, undefined, undefined],
    ["cross-env PORT=4001 nodemon src/index.ts", 4001, undefined, undefined],
    ["set PORT=4002&& node server.js", 4002, undefined, undefined],
    ['set "PORT=4003" && node server.js', 4003, undefined, undefined],
    ["tsc -p tsconfig.json && node dist/server.js", undefined, undefined, undefined],
    ["turbo run dev", undefined, undefined, undefined],
    ["next build", undefined, undefined, undefined],
    ["node server.js --port 99999", undefined, undefined, undefined],
  ])("%s", (command, explicitPort, toolName, defaultPort) => {
    const info = parseScript(command);
    expect(info.explicitPort).toBe(explicitPort);
    expect(info.tool?.name).toBe(toolName);
    expect(info.tool?.defaultPort).toBe(defaultPort);
  });

  it("finds the files a script runs", () => {
    expect(parseScript("node --watch src/server.js").entryFiles).toEqual(["src/server.js"]);
    expect(parseScript("tsx watch ./src/index.ts").entryFiles).toEqual(["src/index.ts"]);
    expect(parseScript("node --env-file=.env -r dotenv/config app.mjs").entryFiles).toEqual([
      "app.mjs",
    ]);
    expect(parseScript("next dev").entryFiles).toEqual([]);
  });

  it("knows which tools ignore PORT in .env", () => {
    expect(parseScript("next dev").tool?.readsDotenvPort).toBe(false);
    expect(parseScript("vite").tool?.readsDotenvPort).toBe(false);
    expect(parseScript("nest start").tool?.readsDotenvPort).toBe(true);
  });
});

describe("findListenPort", () => {
  it.each([
    ["app.listen(4000);", 4000],
    ["app.listen(process.env.PORT || 4001, () => {});", 4001],
    ["const PORT = process.env.PORT || 4002;\napp.listen(PORT);", 4002],
    ["const port = Number(process.env.PORT ?? 4003);\nserver.listen(port, cb);", 4003],
    ["const PORT = parseInt(process.env.PORT, 10) || 4004;\napp.listen(PORT);", 4004],
    ['const PORT = parseInt(process.env.PORT || "4005", 10);\napp.listen(PORT);', 4005],
    ["fastify.listen({ port: 4006, host: '0.0.0.0' });", 4006],
    ["serve({ fetch: app.fetch, port: 8787 });", 8787],
    ["const port = 4007;\nserve({ fetch: app.fetch, port });", 4007],
    ["serve(app, { port: 4008 });", 4008],
    ["http.createServer(handler).listen(4009, '127.0.0.1');", 4009],
    ["Bun.serve({ port: 4010, fetch() {} });", 4010],
  ])("%s → %i", (source, port) => {
    expect(findListenPort(source)?.port).toBe(port);
  });

  it.each([
    "app.listen(process.env.PORT);",
    "// app.listen(4000);",
    "/* app.listen(4000); */",
    "const x = 1;",
    "window.addEventListener('load', go);",
  ])("finds nothing in %s", (source) => {
    expect(findListenPort(source)).toBeUndefined();
  });

  it("reports the line of the call, ignoring comments above it", () => {
    const source = "/* setup\n   more */\nconst app = express();\n\napp.listen(5000);\n";
    expect(findListenPort(source)).toEqual({ port: 5000, line: 5 });
  });
});
