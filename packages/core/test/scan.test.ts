import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanRoutes, type DetectedRoute } from "../src/index.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

const keys = (routes: DetectedRoute[]): string[] => routes.map((route) => route.key);
const byKey = (routes: DetectedRoute[], key: string): DetectedRoute => {
  const route = routes.find((item) => item.key === key);
  if (!route) throw new Error(`No route ${key}. Found: ${keys(routes).join(", ")}`);
  return route;
};

describe("scanRoutes: Next.js App Router (fixtures/next-app-routes)", () => {
  it("finds every route handler, with Express-style paths", async () => {
    const { routes, frameworks } = await scanRoutes(fixture("next-app-routes"));
    expect(frameworks).toEqual(["next-app", "next-pages"]);
    expect(keys(routes)).toEqual([
      "GET /api/docs{/*slug}",
      "GET /api/files/*path",
      "GET /api/posts",
      "POST /api/posts",
      "GET /api/posts/:id",
      "PATCH /api/posts/:id",
      "DELETE /api/posts/:id",
      "GET /api/stats",
      "HEAD /api/stats",
      "POST /api/users",
      "POST /api/webhooks",
      "GET /feed.xml",
    ]);
  });

  it("points at the line of each export", async () => {
    const { routes } = await scanRoutes(fixture("next-app-routes"));
    expect(byKey(routes, "POST /api/posts")).toMatchObject({
      file: "src/app/api/posts/route.ts",
      line: 11,
      framework: "next-app",
      anyMethod: false,
    });
    expect(byKey(routes, "DELETE /api/posts/:id")).toMatchObject({ line: 27 });
    expect(byKey(routes, "HEAD /api/stats")).toMatchObject({
      file: "src/app/api/(admin)/stats/route.ts",
      line: 5,
    });
  });

  it("reads zod body schemas through path aliases, relative imports and re-exports", async () => {
    const { routes } = await scanRoutes(fixture("next-app-routes"));

    expect(byKey(routes, "POST /api/posts").body).toEqual({
      sample: {
        title: "example",
        body: "example",
        tags: ["example"],
        published: false,
        author: { name: "example", email: "user@example.com" },
        publishAt: "2026-01-01T00:00:00Z",
        website: "https://example.com",
      },
      exact: true,
      from: "zod",
      schema: { name: "CreatePost", file: "src/lib/schemas.ts", line: 8 },
      notes: [],
    });
    expect(byKey(routes, "PATCH /api/posts/:id").body).toMatchObject({
      sample: { title: "example", status: "draft", rating: 3 },
      exact: true,
      schema: { name: "UpdatePost", file: "src/app/api/posts/[id]/route.ts" },
    });
    expect(byKey(routes, "POST /api/users").body).toMatchObject({
      sample: {
        username: "example",
        age: 1,
        role: "member",
        id: "00000000-0000-4000-8000-000000000000",
      },
      exact: true,
    });
    expect(byKey(routes, "POST /api/webhooks").body).toMatchObject({
      sample: { type: "post.created", postId: "example" },
      schema: { name: "WebhookEvent", file: "src/lib/webhook-handler.ts" },
    });
    expect(byKey(routes, "GET /api/posts").body).toBeUndefined();
    expect(byKey(routes, "DELETE /api/posts/:id").body).toBeUndefined();
  });
});

describe("scanRoutes: Next.js Pages API (fixtures/next-pages-api)", () => {
  it("finds methods from req.method checks", async () => {
    const { routes } = await scanRoutes(fixture("next-pages-api"));
    expect(keys(routes)).toEqual([
      "GET /api/auth/*nextauth",
      "GET /api/health",
      "GET /api/hello",
      "POST /api/orders",
      "POST /api/subscribe",
      "GET /api/users",
      "POST /api/users",
      "GET /api/users/:id",
      "PUT /api/users/:id",
      "DELETE /api/users/:id",
    ]);
  });

  it("marks handlers without method checks as answering every method", async () => {
    const { routes } = await scanRoutes(fixture("next-pages-api"));
    expect(byKey(routes, "GET /api/hello")).toMatchObject({
      anyMethod: true,
      file: "pages/api/hello.js",
    });
    expect(byKey(routes, "POST /api/subscribe")).toMatchObject({
      anyMethod: true,
      body: { sample: { email: "example", frequency: "example" }, from: "fields", exact: false },
    });
    expect(byKey(routes, "GET /api/users")).toMatchObject({ anyMethod: false, line: 12 });
    expect(byKey(routes, "POST /api/users")).toMatchObject({ line: 14 });
  });

  it("reads the schema used in each method's branch", async () => {
    const { routes } = await scanRoutes(fixture("next-pages-api"));
    expect(byKey(routes, "POST /api/users").body).toMatchObject({
      sample: { name: "example", email: "user@example.com", age: 18 },
      exact: true,
    });
    expect(byKey(routes, "PUT /api/users/:id").body).toMatchObject({
      sample: { name: "example", email: "user@example.com" },
      schema: { name: "UpdateUser", file: "lib/schemas.ts" },
    });
    expect(byKey(routes, "POST /api/orders").body).toMatchObject({
      sample: { items: [{ sku: "examplex", qty: 1 }], coupon: "example", note: "example" },
      exact: true,
    });
    expect(byKey(routes, "GET /api/users/:id").body).toBeUndefined();
  });
});

describe("scanRoutes: Express (fixtures/express-routes)", () => {
  it("follows routers mounted across files, in ESM and CommonJS", async () => {
    const { routes, frameworks } = await scanRoutes(fixture("express-routes"));
    expect(frameworks).toEqual(["express"]);
    expect(keys(routes)).toEqual([
      "GET /",
      "POST /api/legacy/echo",
      "GET /api/legacy/status",
      "GET /api/ping",
      "GET /api/posts",
      "POST /api/posts",
      "PATCH /api/posts/:postId/publish",
      "GET /api/users",
      "POST /api/users",
      "GET /api/users/:id",
      "PUT /api/users/:id",
      "DELETE /api/users/:id",
      "GET /health",
      "GET /ready",
    ]);
  });

  it("skips regex paths and says why, and ignores tests and client code", async () => {
    const { routes, skipped } = await scanRoutes(fixture("express-routes"));
    expect(skipped).toEqual([
      {
        file: "src/app.ts",
        line: 18,
        reason: "the path is not a plain string (regex or variable)",
      },
    ]);
    expect(keys(routes)).not.toContain("GET /only-in-tests");
    expect(routes.every((route) => !route.file.startsWith("src/client/"))).toBe(true);
  });

  it("knows where each route is and what body it expects", async () => {
    const { routes } = await scanRoutes(fixture("express-routes"));
    expect(byKey(routes, "GET /api/ping")).toMatchObject({
      anyMethod: true,
      file: "src/routes/api.ts",
      line: 9,
    });
    expect(byKey(routes, "PUT /api/users/:id")).toMatchObject({
      file: "src/routes/users.ts",
      line: 31,
      body: {
        sample: { name: "example", email: "user@example.com", plan: "free", active: true },
        exact: true,
        schema: { name: "UpdateUser", file: "src/routes/users.ts", line: 11 },
      },
    });
    expect(byKey(routes, "POST /api/users").body).toMatchObject({
      sample: { name: "example", email: "user@example.com", plan: "free" },
      schema: { name: "CreateUser" },
    });
    expect(byKey(routes, "POST /api/posts").body).toMatchObject({
      sample: { title: "example", tags: [], meta: {}, score: 1 },
      exact: true,
      schema: { name: "PostInput", file: "src/schemas/post.ts" },
    });
    expect(byKey(routes, "POST /api/legacy/echo")).toMatchObject({
      file: "src/routes/legacy.cjs",
      body: { sample: { message: "example" }, from: "fields" },
    });
  });
});

describe("scanRoutes: other projects", () => {
  it("returns nothing for a project without Next.js or Express", async () => {
    expect(await scanRoutes(fixture("vite"))).toEqual({
      routes: [],
      skipped: [],
      frameworks: [],
      filesScanned: 0,
    });
  });

  it("finds the health route of the M2 Next.js fixture", async () => {
    const { routes } = await scanRoutes(fixture("next-default"));
    expect(keys(routes)).toEqual(["GET /api/health"]);
  });

  it("makes paths relative to the given root (monorepos)", async () => {
    const root = fixture("monorepo");
    const { routes } = await scanRoutes(fixture("monorepo/apps/web"), { root });
    expect(routes.every((route) => route.file.startsWith("apps/web/"))).toBe(true);
  });
});
