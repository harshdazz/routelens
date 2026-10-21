import { describe, expect, it } from "vitest";
import type { ApiResponse } from "@routelens/core";
import {
  escapeHtml,
  formatBytes,
  formatDuration,
  prettyBody,
  renderErrorHtml,
  renderResponseHtml,
  statusClass,
} from "../src/responseHtml";

const response = (overrides: Partial<ApiResponse> = {}): ApiResponse => ({
  status: 200,
  statusText: "OK",
  url: "http://localhost:4000/api/health",
  headers: { "content-type": "application/json" },
  body: '{"status":"ok"}',
  sizeBytes: 15,
  truncated: false,
  durationMs: 12.4,
  ...overrides,
});

describe("formatting helpers", () => {
  it("escapes every HTML-sensitive character", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("formats sizes and durations", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatDuration(12.4)).toBe("12 ms");
    expect(formatDuration(1530)).toBe("1.53 s");
  });

  it("pretty-prints JSON and leaves other text alone", () => {
    expect(prettyBody('{"a":1}', "application/json")).toBe('{\n  "a": 1\n}');
    expect(prettyBody("<html></html>", "text/html")).toBe("<html></html>");
    expect(prettyBody("{not json", "application/json")).toBe("{not json");
  });

  it("maps status codes to colours", () => {
    expect(statusClass(201)).toBe("ok");
    expect(statusClass(304)).toBe("redirect");
    expect(statusClass(404)).toBe("error");
    expect(statusClass(500)).toBe("error");
  });
});

describe("renderResponseHtml", () => {
  it("shows status, timing, size and pretty body", () => {
    const html = renderResponseHtml(
      {
        requestName: "Health",
        method: "GET",
        url: "x",
        environmentName: "local",
        response: response(),
      },
      "abc",
    );
    expect(html).toContain("200 OK");
    expect(html).toContain("12 ms");
    expect(html).toContain("15 B");
    expect(html).toContain("env: local");
    expect(html).toContain("&quot;status&quot;: &quot;ok&quot;");
  });

  it("escapes a malicious response so no markup can run", () => {
    const html = renderResponseHtml(
      {
        requestName: "<img src=x onerror=alert(1)>",
        method: "GET",
        url: "x",
        environmentName: undefined,
        response: response({
          headers: { "x-evil": "<script>alert(1)</script>" },
          body: "<script>alert(1)</script>",
        }),
      },
      "abc",
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  it("uses a strict Content-Security-Policy with the nonce", () => {
    const html = renderResponseHtml(
      {
        requestName: "x",
        method: "GET",
        url: "x",
        environmentName: undefined,
        response: response(),
      },
      "n0nce",
    );
    expect(html).toContain("default-src 'none'; style-src 'nonce-n0nce';");
    expect(html).toContain('<style nonce="n0nce">');
  });

  it("mentions when the body was cut", () => {
    const html = renderResponseHtml(
      {
        requestName: "x",
        method: "GET",
        url: "x",
        environmentName: undefined,
        response: response({ body: "xxxx", sizeBytes: 4096, truncated: true }),
      },
      "n",
    );
    expect(html).toContain("Body cut at 4 B of 4.0 KB.");
  });
});

describe("renderErrorHtml", () => {
  it("shows the message and hint, escaped", () => {
    const html = renderErrorHtml(
      {
        requestName: "x",
        method: "GET",
        url: "http://localhost:1",
        message: "ECONNREFUSED <x>",
        hint: "Start it",
      },
      "n",
    );
    expect(html).toContain("Request failed");
    expect(html).toContain("ECONNREFUSED &lt;x&gt;");
    expect(html).toContain("Start it");
  });
});
