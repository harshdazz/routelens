import { describe, expect, it } from "vitest";
import type { RouteLensError } from "../src/index.js";
import {
  checkResponse,
  expects401,
  findToken,
  parseFlow,
  parseRequest,
  parseValuePath,
  readValuePath,
  resolveRequest,
  type ApiResponse,
  type Expectation,
} from "../src/index.js";

const response = (status: number, body: unknown, extra: Partial<ApiResponse> = {}): ApiResponse => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    statusText: "",
    url: "http://localhost/x",
    headers: { "content-type": "application/json; charset=utf-8" },
    setCookies: [],
    body: text,
    sizeBytes: text.length,
    truncated: false,
    durationMs: 42,
    ...extra,
  };
};

const failures = (
  res: ApiResponse,
  expectation: Expectation,
): Array<[string, string | undefined]> =>
  checkResponse(res, expectation)
    .filter((check) => !check.passed)
    .map((check) => [check.label, check.detail]);

describe("value paths", () => {
  it("parse names, indexes and quoted keys", () => {
    expect(parseValuePath("body.items[0].id")).toEqual(["body", "items", 0, "id"]);
    expect(parseValuePath('body["first name"].x')).toEqual(["body", "first name", "x"]);
    expect(parseValuePath("headers.content-type")).toEqual(["headers", "content-type"]);
    for (const bad of ["", ".body", "body.", "body..x", "body[x]", "body[0"]) {
      expect(parseValuePath(bad), bad).toBeUndefined();
    }
  });

  it("read values, header names in any case, and length", () => {
    const subject = {
      status: 200,
      headers: { "x-id": "7" },
      body: { items: [{ id: 1 }], name: "Ada" },
    };
    expect(readValuePath(subject, "body.items[0].id")).toEqual({ found: true, value: 1 });
    expect(readValuePath(subject, "body.items.0.id")).toEqual({ found: true, value: 1 });
    expect(readValuePath(subject, "headers.X-Id")).toEqual({ found: true, value: "7" });
    expect(readValuePath(subject, "body.items.length")).toEqual({ found: true, value: 1 });
    expect(readValuePath(subject, "body.name.length")).toEqual({ found: true, value: 3 });
    expect(readValuePath(subject, "body.items[3]").found).toBe(false);
    expect(readValuePath(subject, "body.missing.deep").found).toBe(false);
    expect(readValuePath(subject, "body.constructor").found).toBe(false);
  });
});

describe("checkResponse", () => {
  it("passes a status below 400 when there is no expect block", () => {
    expect(checkResponse(response(201, {}), undefined)).toEqual([
      { label: "status is below 400", passed: true },
    ]);
    expect(checkResponse(response(500, {}), undefined)[0]).toMatchObject({
      passed: false,
      detail: "got 500 Internal Server Error",
    });
  });

  it("checks a status code, a list of codes or a class", () => {
    expect(failures(response(201, {}), { status: 201 })).toEqual([]);
    expect(failures(response(204, {}), { status: [200, 201] })).toEqual([
      ["status is 200 or 201", "got 204 No Content"],
    ]);
    expect(failures(response(204, {}), { status: "2xx" })).toEqual([]);
    expect(failures(response(302, {}), { status: "2xx" })).toEqual([
      ["status is 2xx", "got 302 Found"],
    ]);
  });

  it("matches the body partially: objects may have more fields, arrays must be equal", () => {
    const res = response(200, { user: { id: 1, name: "Ada", tags: ["a", "b"] }, extra: true });
    expect(failures(res, { body: { user: { name: "Ada" } } })).toEqual([]);
    expect(failures(res, { body: { user: { tags: ["a"] } } })).toEqual([
      ['body contains {"user":{"tags":["a"]}}', 'body.user.tags is ["a","b"], expected ["a"]'],
    ]);
    expect(failures(res, { body: { user: { email: "x" } } })[0]?.[1]).toBe(
      "body.user.email is missing",
    );
    expect(failures(response(200, "plain text"), { body: { a: 1 } })[0]?.[1]).toBe(
      "the body is not JSON",
    );
  });

  it("checks values with plain values and every matcher", () => {
    const res = response(200, { id: 7, name: "Ada", tags: ["x", { k: 1, j: 2 }], none: null });
    const passing: Array<Expectation["values"]> = [
      { "body.id": 7, "body.tags": ["x", { k: 1, j: 2 }], "body.missing": { exists: false } },
      {
        "body.name": { type: "string" },
        "body.none": { type: "null" },
        "body.id": { exists: true },
      },
      { "body.tags.length": { greaterThan: 1 }, durationMs: { lessThan: 1000 } },
      { "headers.content-type": { contains: "json" }, "body.tags": { contains: { k: 1 } } },
      { "body.name": { matches: "^A" }, "body.id": { matches: "^7$" } },
    ];
    for (const values of passing) expect(failures(res, { values })).toEqual([]);

    expect(
      failures(res, {
        values: {
          "body.id": "7",
          "body.name": { type: "number" },
          "body.missing": { exists: true },
          "body.tags": { contains: "y" },
          durationMs: { lessThan: 10 },
        },
      }),
    ).toEqual([
      ['body.id is "7"', "got 7"],
      ["body.name is a number", 'got string "Ada"'],
      ["body.missing exists", "body.missing is missing"],
      ['body.tags contains "y"', 'got ["x",{"k":1,"j":2}]'],
      ["durationMs is less than 10", "got 42"],
    ]);
    expect(failures(res, { values: { "body.nope": { matches: "^8" } } })).toEqual([
      ["body.nope matches /^8/", "body.nope is missing"],
    ]);
  });

  it("checks how long the response took", () => {
    expect(failures(response(200, {}), { maxDurationMs: 40 })).toEqual([
      ["took at most 40 ms", "took 42 ms"],
    ]);
  });

  it("knows when a request expects a 401", () => {
    expect(expects401({ status: 401 })).toBe(true);
    expect(expects401({ status: [200, 401] })).toBe(true);
    expect(expects401({ status: "4xx" })).toBe(true);
    expect(expects401({ status: 403 })).toBe(false);
    expect(expects401(undefined)).toBe(false);
  });
});

describe("expect and flow files", () => {
  const withExpect = (expectBlock: unknown): string =>
    JSON.stringify({ version: 1, name: "x", method: "GET", url: "/", expect: expectBlock });

  it("accept valid expect blocks", () => {
    expect(
      parseRequest(
        withExpect({ status: "2xx", values: { "body.id": { type: "number" }, "body.ok": true } }),
      ).expect,
    ).toEqual({ status: "2xx", values: { "body.id": { type: "number" }, "body.ok": true } });
  });

  it("explain mistakes: unknown fields, two checks in one matcher, bad paths and patterns", () => {
    const problems = (block: unknown): readonly string[] => {
      try {
        parseRequest(withExpect(block));
        return [];
      } catch (error) {
        return (error as RouteLensError).details;
      }
    };
    expect(problems({ stauts: 200 })[0]).toContain('Unrecognized key: "stauts"');
    expect(problems({ status: "200" })[0]).toBe(
      'expect.status: Use a code (201), a list ([200, 201]) or "2xx".',
    );
    expect(problems({ values: { "body.id": { type: "number", exists: true } } })[0]).toContain(
      "expect.values.body.id",
    );
    expect(problems({ values: { "data.id": 1 } })[0]).toContain(
      "Start with status, durationMs, headers or body",
    );
    expect(problems({ values: { "body.id": { matches: "(" } } }).join("\n")).toContain(
      "Not a valid regular expression",
    );
  });

  it("parse flows and reject unknown step fields", () => {
    const flow = parseFlow(
      JSON.stringify({
        version: 1,
        name: "f",
        steps: [{ request: "create-post", extract: { postId: "body.id" } }],
      }),
    );
    expect(flow).toMatchObject({ variables: {}, steps: [{ extract: { postId: "body.id" } }] });
    expect(() =>
      parseFlow(JSON.stringify({ version: 1, name: "f", steps: [{ request: "x", expext: {} }] })),
    ).toThrow(/Unrecognized key: "expext"/);
    expect(() => parseFlow(JSON.stringify({ version: 1, name: "f", steps: [] }))).toThrow(
      /steps: Too small/,
    );
  });
});

describe("typed values in resolveRequest", () => {
  it("keeps the type of a whole placeholder in a JSON body, and uses text elsewhere", () => {
    const request = parseRequest(
      JSON.stringify({
        version: 1,
        name: "x",
        method: "POST",
        url: "{{baseUrl}}/posts/{{postId}}",
        body: {
          type: "json",
          content: { id: "{{postId}}", label: "post {{postId}}", tags: "{{tags}}" },
        },
      }),
    );
    const { request: resolved, missingVariables } = resolveRequest(
      request,
      { baseUrl: "http://x", postId: "old" },
      { postId: 2, tags: ["a"] },
    );
    expect(resolved.url).toBe("http://x/posts/2");
    expect(JSON.parse(resolved.body ?? "")).toEqual({ id: 2, label: "post 2", tags: ["a"] });
    expect(missingVariables).toEqual([]);
  });
});

describe("findToken", () => {
  it("finds the token field closest to the top, in any common spelling", () => {
    expect(findToken(response(200, { access_token: "a", data: { token: "b" } }))).toEqual({
      kind: "bearer",
      value: "a",
    });
    expect(findToken(response(200, { data: { session: { idToken: "deep" } } }))).toEqual({
      kind: "bearer",
      value: "deep",
    });
    expect(findToken(response(200, { a: { b: { c: { token: "too deep" } } } }))).toBeUndefined();
  });

  it("falls back to the cookies the server set", () => {
    const res = response(204, "", {
      setCookies: [
        "sid=abc; Path=/; HttpOnly",
        "theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      ],
    });
    expect(findToken(res)).toEqual({ kind: "cookie", value: "sid=abc; theme=dark" });
  });
});
