import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouteLensError, sendRequest } from "../src/index.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 1_000);
        return;
      }
      if (req.url === "/big") {
        res.end("x".repeat(100));
        return;
      }
      res.writeHead(req.method === "POST" ? 201 : 200, {
        "Content-Type": "application/json",
        "X-Test": "yes",
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          contentType: req.headers["content-type"] ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("sendRequest", () => {
  it("returns status, lower-case headers, body, size and timing", async () => {
    const response = await sendRequest({ method: "GET", url: `${baseUrl}/hello?x=1`, headers: {} });
    expect(response.status).toBe(200);
    expect(response.headers["x-test"]).toBe("yes");
    expect(JSON.parse(response.body)).toMatchObject({ method: "GET", url: "/hello?x=1" });
    expect(response.sizeBytes).toBe(Buffer.byteLength(response.body));
    expect(response.truncated).toBe(false);
    expect(response.durationMs).toBeGreaterThan(0);
  });

  it("sends the body and headers", async () => {
    const response = await sendRequest({
      method: "POST",
      url: `${baseUrl}/posts`,
      headers: { "Content-Type": "application/json" },
      body: '{"title":"Hello"}',
    });
    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({
      contentType: "application/json",
      body: '{"title":"Hello"}',
    });
  });

  it("truncates large bodies but reports the full size", async () => {
    const response = await sendRequest(
      { method: "GET", url: `${baseUrl}/big`, headers: {} },
      { maxBodyBytes: 10 },
    );
    expect(response.body).toBe("x".repeat(10));
    expect(response.sizeBytes).toBe(100);
    expect(response.truncated).toBe(true);
  });

  it("fails with a timeout error", async () => {
    await expect(
      sendRequest({ method: "GET", url: `${baseUrl}/slow`, headers: {} }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("fails with an aborted error when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = sendRequest(
      { method: "GET", url: `${baseUrl}/slow`, headers: {} },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("fails with a network error when nothing is listening", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const error = await sendRequest({
      method: "GET",
      url: `http://127.0.0.1:${port}/`,
      headers: {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RouteLensError);
    expect((error as RouteLensError).code).toBe("network");
    expect((error as RouteLensError).message).toContain("ECONNREFUSED");
  });

  it("rejects URLs that are not http(s)", async () => {
    await expect(
      sendRequest({ method: "GET", url: "{{baseUrl}}/x", headers: {} }),
    ).rejects.toMatchObject({
      code: "invalid-request",
    });
    await expect(
      sendRequest({ method: "GET", url: "file:///etc/passwd", headers: {} }),
    ).rejects.toMatchObject({
      code: "invalid-request",
    });
  });
});
