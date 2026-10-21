import { describe, expect, it } from "vitest";
import { joinRoutePath, matchRoute, nextRoutePath, routeParams, samplePath } from "../src/index.js";

describe("route paths", () => {
  it("join, read Next.js folders, list params and make a sendable sample", () => {
    expect(joinRoutePath("/api/", "users/")).toBe("/api/users");
    expect(nextRoutePath(["api", "(admin)", "posts", "[id]"])).toBe("/api/posts/:id");
    expect(nextRoutePath(["api", "docs", "[[...slug]]"])).toBe("/api/docs{/*slug}");
    expect(routeParams("/users/:id/*rest")).toEqual(["id", "rest"]);
    expect(samplePath("/posts/:postId/tags/:name")).toBe("/posts/1/tags/example");
  });
});

describe("matchRoute", () => {
  const routes = [
    { method: "GET", path: "/api/posts" },
    { method: "GET", path: "/api/posts/:id" },
    { method: "GET", path: "/api/posts/latest" },
    { method: "POST", path: "/api/posts" },
    { method: "GET", path: "/api/files/*path" },
    { method: "GET", path: "/api/docs{/*slug}" },
    { method: "GET", path: "/v1.0/x" },
  ];
  const match = (method: string, url: string) => matchRoute(routes, method, url)?.path;

  it("matches the method and the path, with or without a host, query or trailing slash", () => {
    expect(match("GET", "http://localhost:3000/api/posts/7?x=1")).toBe("/api/posts/:id");
    expect(match("get", "/api/posts/")).toBe("/api/posts");
    expect(match("POST", "/api/posts")).toBe("/api/posts");
    expect(match("DELETE", "/api/posts/7")).toBeUndefined();
    expect(match("GET", "/api/posts/7/comments")).toBeUndefined();
  });

  it("prefers fixed segments over parameters", () => {
    expect(match("GET", "/api/posts/latest")).toBe("/api/posts/latest");
  });

  it("handles catch-all and optional parts, and dots in fixed segments", () => {
    expect(match("GET", "/api/files/a/b.txt")).toBe("/api/files/*path");
    expect(match("GET", "/api/files")).toBeUndefined();
    expect(match("GET", "/api/docs")).toBe("/api/docs{/*slug}");
    expect(match("GET", "/api/docs/guide/intro")).toBe("/api/docs{/*slug}");
    expect(match("GET", "/v1.0/x")).toBe("/v1.0/x");
    expect(match("GET", "/v1x0/x")).toBeUndefined();
  });
});
