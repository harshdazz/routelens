import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { RouteLensError } from "./errors.js";

export interface PortCheckOptions {
  /** Default `localhost`. */
  host?: string;
  /** How long one connection attempt may take. Default 300 ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WaitForPortOptions {
  /** Default `localhost`. */
  host?: string;
  /** Give up after this long. Default 60 seconds. */
  timeoutMs?: number;
  /** Pause between two checks. Default 250 ms. */
  intervalMs?: number;
  /** Abort to stop waiting (a "Cancel" button, or the server process exited). */
  signal?: AbortSignal;
}

const DEFAULT_CHECK_TIMEOUT_MS = 300;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 250;

/**
 * True if something accepts TCP connections on `port`. Never throws.
 * A TCP connect is the cheapest "is the server up?" check: no HTTP request is sent.
 */
export function isPortOpen(port: number, options: PortCheckOptions = {}): Promise<boolean> {
  const { host = "localhost", timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, signal } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    // autoSelectFamily tries both ::1 and 127.0.0.1 for "localhost", so a server that
    // listens on only one of them is still found.
    const socket = connect({ host, port, autoSelectFamily: true });
    const finish = (open: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(open);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolve as soon as `port` accepts connections.
 * Throws a RouteLensError: "timeout" when the time is up, "aborted" when `signal` fires.
 */
export async function waitForPort(port: number, options: WaitForPortOptions = {}): Promise<void> {
  const {
    host = "localhost",
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    signal,
  } = options;
  const deadline = performance.now() + timeoutMs;
  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw new RouteLensError("aborted", `Stopped waiting for port ${port}.`, {
        cause: signal.reason,
      });
    }
  };

  for (;;) {
    throwIfAborted();
    if (await isPortOpen(port, { host, signal })) return;
    throwIfAborted();
    const left = deadline - performance.now();
    if (left <= 0) {
      throw new RouteLensError(
        "timeout",
        `Nothing answered on port ${port} after ${Math.round(timeoutMs / 1000)} s.`,
      );
    }
    try {
      await sleep(Math.min(intervalMs, left), undefined, { signal });
    } catch {
      throwIfAborted();
    }
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * If `url` points at this machine, its host and port. Used to decide whether RouteLens
 * can check (and start) the server before sending. Remote URLs return `undefined`.
 */
export function localServerOf(url: string): { host: string; port: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname;
  if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost")) return undefined;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  // Connect to the loopback address: "0.0.0.0" and "*.localhost" are not dialable everywhere.
  return { host: host === "[::1]" || host === "::1" ? "::1" : "localhost", port };
}
