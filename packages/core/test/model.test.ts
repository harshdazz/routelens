import { describe, expect, it } from "vitest";
import { RouteLensError, fileJsonSchemas, parseEnvironment, parseRequest } from "../src/index.js";

describe("parseRequest", () => {
  it("fills in defaults for optional fields", () => {
    const request = parseRequest(
      JSON.stringify({ version: 1, name: "Health", method: "GET", url: "{{baseUrl}}/health" }),
    );
    expect(request).toEqual({
      version: 1,
      name: "Health",
      method: "GET",
      url: "{{baseUrl}}/health",
      headers: {},
      query: {},
      body: { type: "none" },
    });
  });

  it("explains invalid JSON with the file name", () => {
    expect(() => parseRequest("{ nope", "broken.req.json")).toThrowError(
      /broken\.req\.json is not valid JSON/,
    );
  });

  it("lists every schema problem with its path", () => {
    try {
      parseRequest(
        JSON.stringify({ version: 2, name: "", method: "FETCH", url: "x" }),
        "bad.req.json",
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RouteLensError);
      const details = (error as RouteLensError).details;
      expect(details.some((line) => line.startsWith("version:"))).toBe(true);
      expect(details.some((line) => line.startsWith("name:"))).toBe(true);
      expect(details.some((line) => line.startsWith("method:"))).toBe(true);
      expect((error as RouteLensError).code).toBe("invalid-file");
    }
  });

  it("rejects an unknown body type", () => {
    const text = JSON.stringify({
      version: 1,
      name: "x",
      method: "POST",
      url: "http://x",
      body: { type: "xml", content: "<a/>" },
    });
    expect(() => parseRequest(text)).toThrowError(RouteLensError);
  });
});

describe("parseEnvironment", () => {
  it("parses variables", () => {
    const env = parseEnvironment(
      JSON.stringify({
        version: 1,
        name: "local",
        variables: { baseUrl: "http://localhost:4000" },
      }),
    );
    expect(env.variables.baseUrl).toBe("http://localhost:4000");
  });

  it("rejects non-string values", () => {
    const text = JSON.stringify({ version: 1, name: "local", variables: { port: 4000 } });
    expect(() => parseEnvironment(text)).toThrowError(/variables\.port/);
  });
});

describe("fileJsonSchemas", () => {
  it("produces JSON Schemas that list the HTTP methods", () => {
    const { request } = fileJsonSchemas();
    expect(JSON.stringify(request)).toContain('"PATCH"');
  });
});
