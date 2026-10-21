import { describe, expect, it } from "vitest";
import type { ApiResponse } from "@routelens/core";
import { inlineResultTitle, inlineResultTooltip, type LastResult } from "../src/inlineResult";
import { startDecision } from "../src/serverPolicy";

const responseResult = (overrides: Partial<ApiResponse> = {}): LastResult => ({
  kind: "response",
  view: {
    requestName: "Create post",
    method: "POST",
    url: "http://localhost:3000/api/posts",
    environmentName: "local",
    response: {
      status: 201,
      statusText: "Created",
      url: "http://localhost:3000/api/posts",
      headers: { "content-type": "application/json" },
      setCookies: [],
      body: '{"id":1}',
      sizeBytes: 8,
      truncated: false,
      durationMs: 14.2,
      ...overrides,
    },
  },
});

const errorResult = (code: "network" | "timeout" | undefined): LastResult => ({
  kind: "error",
  code,
  view: {
    requestName: "x",
    method: "GET",
    url: "http://localhost:1",
    message: "Could not reach localhost:1",
    hint: "Is your server running?",
  },
});

describe("inlineResultTitle", () => {
  it("shows a tick, status, reason and time for a success", () => {
    expect(inlineResultTitle(responseResult())).toBe("✓ 201 Created · 14 ms");
  });

  it("shows a cross for 4xx and 5xx", () => {
    expect(inlineResultTitle(responseResult({ status: 404, statusText: "Not Found" }))).toBe(
      "✗ 404 Not Found · 14 ms",
    );
  });

  it("fills in the reason when the server sends none (HTTP/2, some frameworks)", () => {
    expect(inlineResultTitle(responseResult({ status: 500, statusText: "" }))).toBe(
      "✗ 500 Internal Server Error · 14 ms",
    );
    expect(inlineResultTitle(responseResult({ status: 599, statusText: "" }))).toBe(
      "✗ 599 · 14 ms",
    );
  });

  it("names the kind of failure", () => {
    expect(inlineResultTitle(errorResult("network"))).toBe("✗ Can't connect");
    expect(inlineResultTitle(errorResult("timeout"))).toBe("✗ Timed out");
    expect(inlineResultTitle(errorResult(undefined))).toBe("✗ Failed");
    expect(inlineResultTitle({ kind: "sending" })).toBe("$(sync~spin) Sending...");
  });
});

describe("inlineResultTooltip", () => {
  it("previews the pretty body", () => {
    expect(inlineResultTooltip(responseResult())).toBe(
      '{\n  "id": 1\n}\n\nClick to open the full response.',
    );
  });

  it("cuts long bodies", () => {
    const tooltip = inlineResultTooltip(responseResult({ body: "x".repeat(2000) }));
    expect(tooltip.startsWith(`${"x".repeat(600)}\n...`)).toBe(true);
  });

  it("shows the error message and hint", () => {
    expect(inlineResultTooltip(errorResult("network"))).toBe(
      "Could not reach localhost:1\n\nIs your server running?",
    );
  });
});

describe("startDecision", () => {
  it("never starts without a first click in this workspace", () => {
    expect(startDecision("always", false)).toBe("ask");
    expect(startDecision("ask", false)).toBe("ask");
  });

  it("follows the setting after the first click", () => {
    expect(startDecision("always", true)).toBe("start");
    expect(startDecision("ask", true)).toBe("ask");
  });

  it("never offers when the setting is never, and treats unknown values as ask", () => {
    expect(startDecision("never", false)).toBe("skip");
    expect(startDecision("never", true)).toBe("skip");
    expect(startDecision("sometimes", true)).toBe("ask");
    expect(startDecision(undefined, true)).toBe("ask");
  });
});
