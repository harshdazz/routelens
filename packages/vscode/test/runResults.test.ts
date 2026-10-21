import { describe, expect, it } from "vitest";
import type { ApiResponse, FlowRun, RequestRun, StepRun } from "@routelens/core";
import {
  inlineResultTitle,
  inlineResultTooltip,
  resultPassed,
  runLine,
  runToResult,
  type LastResult,
} from "../src/inlineResult";
import { renderFlowHtml, renderResponseHtml } from "../src/responseHtml";
import { testSummaryText } from "../src/routeText";

// How M4 runs (expect checks, flows, auto-login) are shown inline, in the panel and in logs.

const response = (status: number, body = '{"id":1}'): ApiResponse => ({
  status,
  statusText: "",
  url: "http://localhost:3000/api/posts",
  headers: { "content-type": "application/json" },
  setCookies: [],
  body,
  sizeBytes: body.length,
  truncated: false,
  durationMs: 14.2,
});

const run = (overrides: Partial<RequestRun> = {}): RequestRun => ({
  name: "Create post",
  method: "POST",
  url: "http://localhost:3000/api/posts",
  response: response(201),
  checks: [{ label: "status is 201", passed: true }],
  passed: true,
  loggedIn: false,
  durationMs: 15,
  ...overrides,
});

const step = (index: number, overrides: Partial<RequestRun> = {}): StepRun => ({
  ...run(overrides),
  index,
  extracted: {},
});

const flow = (overrides: Partial<FlowRun> = {}): LastResult => ({
  kind: "flow",
  view: {
    flowName: "Create and read",
    environmentName: "local",
    run: {
      name: "Create and read",
      file: undefined,
      steps: [step(0, { name: "Create" }), step(1, { name: "Read" })],
      skipped: [],
      passed: true,
      durationMs: 40,
      ...overrides,
    },
  },
});

describe("runToResult", () => {
  it("passes on the checks, so an expected 400 is a ✓", () => {
    const result = runToResult(
      run({ response: response(400), checks: [{ label: "status is 400", passed: true }] }),
      "local",
    );
    expect(resultPassed(result)).toBe(true);
    expect(inlineResultTitle(result)).toBe("✓ 400 Bad Request · 14 ms");
  });

  it("names a failed check that is not about the status", () => {
    const result = runToResult(
      run({
        passed: false,
        checks: [
          { label: "status is 201", passed: true },
          { label: "body.id is a number", passed: false, detail: 'got string "1"' },
        ],
      }),
      undefined,
    );
    expect(inlineResultTitle(result)).toBe("✗ 201 Created · 14 ms · failed: body.id is a number");
    expect(inlineResultTooltip(result).split("\n")[0]).toBe(
      '✗ body.id is a number: got string "1"',
    );
  });

  it("counts several failed checks, and leaves the status to the title", () => {
    const result = runToResult(
      run({
        response: response(500),
        passed: false,
        checks: [
          { label: "status is 201", passed: false, detail: "got 500" },
          { label: "body.a is 1", passed: false },
          { label: "body.b is 2", passed: false },
        ],
      }),
      "local",
    );
    expect(inlineResultTitle(result)).toBe("✗ 500 Internal Server Error · 14 ms · 2 checks failed");
  });

  it("turns a run without a response into an error with a hint", () => {
    const result = runToResult(
      run({
        response: undefined,
        passed: false,
        error: { code: "network", message: "Could not reach" },
      }),
      "local",
    );
    expect(result).toMatchObject({
      kind: "error",
      code: "network",
      view: { message: "Could not reach" },
    });
    expect(inlineResultTitle(result)).toBe("✗ Can't connect");
  });

  it("says when RouteLens logged in first", () => {
    const result = runToResult(run({ loggedIn: true }), "local");
    expect(inlineResultTooltip(result).startsWith("Logged in first.")).toBe(true);
    expect(runLine(run({ loggedIn: true }))).toBe(
      "✓ POST http://localhost:3000/api/posts · 201 Created · 14 ms · logged in",
    );
  });
});

describe("flow results", () => {
  it("shows the number of steps and the time when the flow passed", () => {
    expect(inlineResultTitle(flow())).toBe("✓ 2 steps · 40 ms");
  });

  it("names the failing step and why, and lists the steps not run", () => {
    const failed = flow({
      passed: false,
      steps: [
        step(0, { name: "Create" }),
        step(1, {
          name: "Read",
          passed: false,
          response: response(404),
          checks: [{ label: "status is 200", passed: false, detail: "got 404 Not Found" }],
        }),
      ],
      skipped: ["Delete"],
    });
    expect(resultPassed(failed)).toBe(false);
    expect(inlineResultTitle(failed)).toBe(
      '✗ Step 2 of 3 "Read": status is 200: got 404 Not Found',
    );
    expect(inlineResultTooltip(failed)).toBe(
      [
        "✓ 1. Create · 201",
        "✗ 2. Read · 404 · status is 200: got 404 Not Found",
        "– 3. Delete (not run)",
        "",
        "Click to open the details.",
      ].join("\n"),
    );
  });

  it("renders every step in the panel, escaped", () => {
    const result = flow({
      steps: [
        step(0, { name: "<b>Create</b>", checks: [{ label: 'body.x is "<i>"', passed: true }] }),
      ],
    });
    if (result.kind !== "flow") throw new Error("not a flow");
    const html = renderFlowHtml(result.view, "n");
    expect(html).toContain("&lt;b&gt;Create&lt;/b&gt;");
    expect(html).toContain("body.x is &quot;&lt;i&gt;&quot;");
    expect(html).not.toContain("<b>Create");
    expect(html).toContain("1 of 1 steps passed");
  });
});

describe("checks in the response panel", () => {
  it("lists checks, but hides the default one when it passed", () => {
    const view = {
      requestName: "x",
      method: "GET",
      url: "x",
      environmentName: undefined,
      response: response(200),
    };
    expect(
      renderResponseHtml(
        { ...view, checks: [{ label: "status is below 400", passed: true }] },
        "n",
      ),
    ).not.toContain("<h2>Checks</h2>");
    const html = renderResponseHtml(
      { ...view, checks: [{ label: "body.id is a number", passed: false, detail: "got null" }] },
      "n",
    );
    expect(html).toContain("<h2>Checks</h2>");
    expect(html).toContain("✗ body.id is a number");
  });
});

describe("testSummaryText", () => {
  it("leaves out failures when there are none", () => {
    expect(testSummaryText(12, 0, 1300)).toBe("12 passed · 1.30 s");
    expect(testSummaryText(10, 2, 80)).toBe("10 passed · 2 failed · 80 ms");
  });
});
