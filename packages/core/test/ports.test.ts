import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RouteLensError, isPortOpen, localServerOf, waitForPort } from "../src/index.js";

const servers: Server[] = [];

/** Listen on a free port and return it. */
async function listen(port = 0): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("isPortOpen", () => {
  it("is true when a server listens, even on IPv4 only behind 'localhost'", async () => {
    const port = await listen();
    expect(await isPortOpen(port)).toBe(true);
    expect(await isPortOpen(port, { host: "127.0.0.1" })).toBe(true);
  });

  it("is false when nothing listens", async () => {
    expect(await isPortOpen(await freePort())).toBe(false);
  });

  it("is false right away when already aborted", async () => {
    const port = await listen();
    expect(await isPortOpen(port, { signal: AbortSignal.abort() })).toBe(false);
  });
});

describe("waitForPort", () => {
  it("resolves once the server starts", async () => {
    const port = await freePort();
    setTimeout(() => void listen(port), 300);
    const startedAt = performance.now();
    await waitForPort(port, { timeoutMs: 5_000, intervalMs: 50 });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
  });

  it("throws a timeout error when nothing starts", async () => {
    const port = await freePort();
    const error = await waitForPort(port, { timeoutMs: 300, intervalMs: 50 }).catch((e) => e);
    expect(error).toBeInstanceOf(RouteLensError);
    expect(error.code).toBe("timeout");
  });

  it("throws an aborted error with the reason when cancelled", async () => {
    const port = await freePort();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("server exited")), 100);
    const error = await waitForPort(port, { signal: controller.signal, intervalMs: 50 }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(RouteLensError);
    expect(error.code).toBe("aborted");
    expect(error.cause).toEqual(new Error("server exited"));
  });
});

describe("localServerOf", () => {
  it.each([
    ["http://localhost:3000/api", { host: "localhost", port: 3000 }],
    ["http://127.0.0.1:4000", { host: "localhost", port: 4000 }],
    ["http://0.0.0.0:5173", { host: "localhost", port: 5173 }],
    ["http://[::1]:8080/x", { host: "::1", port: 8080 }],
    ["http://app.localhost:3000", { host: "localhost", port: 3000 }],
    ["http://localhost/", { host: "localhost", port: 80 }],
    ["https://localhost/", { host: "localhost", port: 443 }],
  ])("%s is local", (url, expected) => {
    expect(localServerOf(url)).toEqual(expected);
  });

  it.each(["https://api.example.com", "http://192.168.1.5:3000", "not a url", "ftp://localhost"])(
    "%s is not local",
    (url) => {
      expect(localServerOf(url)).toBeUndefined();
    },
  );
});
