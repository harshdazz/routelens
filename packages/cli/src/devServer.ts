import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { RouteLensError, isPortOpen, waitForPort, type StartCommand } from "@routelens/core";

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

  return { ready, output: () => [...lines], stop: () => stop(child, target) };
}

/**
 * Stop the server and everything it started. The shell can exit before the server it
 * started (shell → npm → node), so the proof that it is gone is its port closing: wait for
 * that, and force-kill the whole group if it is still open after 5 seconds.
 */
async function stop(child: ChildProcess, target: { host: string; port: number }): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  signal(pid, "SIGTERM");
  if (await portClosed(target, 5_000)) return;
  signal(pid, "SIGKILL");
  await portClosed(target, 2_000);
}

/** Signal the server's whole process tree (it runs in its own group on Linux and macOS). */
function signal(pid: number, name: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform === "win32") {
      // taskkill /T ends the shell and everything it started (npm, node, next...).
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, name);
    }
  } catch {
    // already gone
  }
}

/** True once nothing answers on the port any more; false if it is still open after `timeoutMs`. */
async function portClosed(
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await isPortOpen(target.port, { host: target.host })) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}
