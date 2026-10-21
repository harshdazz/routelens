import { describe, expect, it } from "vitest";
import {
  RouteLensError,
  parseRequest,
  resolveRequest,
  type ApiRequestInput,
} from "../src/index.js";

const request = (input: Partial<ApiRequestInput>) =>
  parseRequest(
    JSON.stringify({ version: 1, name: "test", method: "GET", url: "http://x", ...input }),
  );

describe("resolveRequest", () => {
  it("fills variables in URL, headers and query, and reports missing ones", () => {
    const { request: resolved, missingVariables } = resolveRequest(
      request({
        url: "{{baseUrl}}/posts",
        headers: { Authorization: "Bearer {{token}}" },
        query: { page: "{{page}}", q: "a b" },
      }),
      { baseUrl: "http://api.test", page: "2" },
    );
    expect(resolved.url).toBe("http://api.test/posts?page=2&q=a+b");
    expect(resolved.headers).toEqual({ Authorization: "Bearer {{token}}" });
    expect(missingVariables).toEqual(["token"]);
  });

  it("appends query params to a URL that already has some", () => {
    const { request: resolved } = resolveRequest(
      request({ url: "http://x/a?b=1", query: { c: "2" } }),
      {},
    );
    expect(resolved.url).toBe("http://x/a?b=1&c=2");
  });

  it("serializes a JSON body, filling variables in nested strings, and sets Content-Type", () => {
    const { request: resolved } = resolveRequest(
      request({
        method: "POST",
        body: { type: "json", content: { title: "{{title}}", tags: ["{{tag}}"], count: 3 } },
      }),
      { title: "Hello", tag: "news" },
    );
    expect(JSON.parse(resolved.body ?? "")).toEqual({ title: "Hello", tags: ["news"], count: 3 });
    expect(resolved.headers["Content-Type"]).toBe("application/json");
  });

  it("keeps a Content-Type the user already set, whatever its casing", () => {
    const { request: resolved } = resolveRequest(
      request({
        method: "POST",
        headers: { "content-type": "application/vnd.api+json" },
        body: { type: "json", content: {} },
      }),
      {},
    );
    expect(resolved.headers).toEqual({ "content-type": "application/vnd.api+json" });
  });

  it("encodes a form body", () => {
    const { request: resolved } = resolveRequest(
      request({ method: "POST", body: { type: "form", content: { user: "{{u}}", note: "a&b" } } }),
      { u: "harsh" },
    );
    expect(resolved.body).toBe("user=harsh&note=a%26b");
    expect(resolved.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("refuses a body on GET", () => {
    expect(() =>
      resolveRequest(request({ method: "GET", body: { type: "text", content: "hi" } }), {}),
    ).toThrowError(RouteLensError);
  });

  it("has no body when the type is none", () => {
    const { request: resolved } = resolveRequest(request({ method: "DELETE" }), {});
    expect(resolved).not.toHaveProperty("body");
  });
});
