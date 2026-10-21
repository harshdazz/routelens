import { spawn, type ChildProcess } from "node:child_process";
import { RouteLensError, waitForPort, type StartCommand } from "@routelens/core";

/** Lines of server output kept to explain a crash or a timeout. */
const KEPT_LINES = 40;

export interface DevServer {
  /** Resolves when the port opens; throws a RouteLensError when the server exits or is too slow. */
  ready: Promise<void>;
  /** The last lines the server printed. */
  output(): string[];
  stop(): Promise<void>;
}

/**
 * `--start`: run the project's `dev` (or `start`) script, the same command zero setup uses in
 * VS Code (ADR-0006), and wait for its port. Only that script is run, and only because the
 * person passed --start.
 */
export function startDevServer(
  start: StartCommand,
  target: { host: string; port: number },
  timeoutMs: number,
): DevServer {
  const lines: string[] = [];
  const keep = (chunk: Buffer): void => {
    lines.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
    lines.splice(0, Math.max(0, lines.length - KEPT_LINES));
  };
  // A shell, so `npm` finds `npm.cmd` on Windows. The command is built by core from a fixed
  // package manager name and the script name, never from repository text.
  const child = spawn(start.command, {
    cwd: start.cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group on Linux and macOS, so stop() ends the whole tree.
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const exited = new AbortController();
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exitCode = code;
    exited.abort();
  });

  const ready = waitForPort(target.port, {
    host: target.host,
    timeoutMs,
    signal: exited.signal,
  }).catch((error: unknown) => {
    if (error instanceof RouteLensError && error.code === "aborted") {
      throw new RouteLensError(
        "network",
        `\`${start.command}\` exited${exitCode === null ? "" : ` with code ${exitCode}`} before port ${target.port} opened.`,
      );
    }
    throw error;
  });

  return { ready, output: () => [...lines], stop: () => stop(child) };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    if (process.platform === "win32") {
      // taskkill /T ends the shell and everything it started (npm, node, next...).
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    return; // already gone
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined)
        process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  await exited;
  clearTimeout(timer);
}
