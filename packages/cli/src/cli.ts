import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  AuthSession,
  DEFAULT_ENVIRONMENT,
  RouteLensError,
  detectServer,
  findLoginRequest,
  findProjectRoot,
  isPortOpen,
  listFlowFiles,
  listRequestFiles,
  localServerOf,
  orderForRun,
  readEnvironment,
  readFlowFile,
  readRequestFile,
  resolveRequest,
  runFlow,
  runRequest,
  waitForPort,
  type ApiRequest,
  type CheckResult,
  type RequestRun,
} from "@routelens/core";
import { startDevServer, type DevServer } from "./devServer.js";
import { toJUnit, type FlowResult, type RequestResult } from "./junit.js";

export const VERSION = "0.0.0";

/** Where the CLI reads and writes, so tests can run it in-process. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}

const USAGE = `Usage: routelens run [folder] [options]

Runs the saved requests (.routelens/requests) and flows (.routelens/flows) of the
project in [folder] (default: the current folder), with plain code and no AI.

Options:
  --env <name>         Environment from .routelens/environments (default: local)
  --var <name=value>   Set a {{variable}}. Repeat for more. ROUTELENS_VAR_<name> works too.
  --only <what>        Run only "requests" or only "flows"
  --junit <file>       Write a JUnit XML report (GitHub Actions, GitLab, Jenkins)
  --start              Start the dev server (the dev or start script in package.json) if
                       it is off, and stop it at the end
  --wait <seconds>     Wait this long for the server to answer (default 0; 60 with --start)
  --timeout <ms>       Timeout of each request (default 30000)
  -h, --help           Show this help
  -v, --version        Show the version

Login: when a route answers 401, RouteLens logs in with your login request, using
ROUTELENS_USERNAME and ROUTELENS_PASSWORD, and reuses the token.

Exit code: 0 when everything passed, 1 when something failed, 2 when it could not run.
`;

/** Run the CLI. Returns the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        env: { type: "string" },
        var: { type: "string", multiple: true },
        only: { type: "string" },
        junit: { type: "string" },
        start: { type: "boolean" },
        wait: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  const [command, folder, ...extra] = positionals;
  if (values.help || command === undefined) {
    (values.help ? io.stdout : io.stderr)(USAGE);
    return values.help ? 0 : 2;
  }
  if (command !== "run" || extra.length > 0) {
    io.stderr(`Unknown command: ${[command, ...extra].join(" ")}\n\n${USAGE}`);
    return 2;
  }
  if (values.only !== undefined && values.only !== "requests" && values.only !== "flows") {
    io.stderr(`--only takes "requests" or "flows", not "${values.only}".\n`);
    return 2;
  }
  const variables = parseVars(values.var ?? [], io);
  const waitSeconds = values.wait === undefined ? (values.start ? 60 : 0) : Number(values.wait);
  const timeoutMs = values.timeout === undefined ? 30_000 : Number(values.timeout);
  if (!variables || !Number.isFinite(waitSeconds) || waitSeconds < 0 || !(timeoutMs > 0)) {
    if (variables) io.stderr("--wait and --timeout take a positive number.\n");
    return 2;
  }

  try {
    return await run(io, {
      folder: path.resolve(io.cwd, folder ?? "."),
      environmentName: values.env,
      variables,
      only: values.only as "requests" | "flows" | undefined,
      junit: values.junit === undefined ? undefined : path.resolve(io.cwd, values.junit),
      start: values.start ?? false,
      waitMs: waitSeconds * 1000,
      timeoutMs,
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

interface RunSettings {
  folder: string;
  environmentName: string | undefined;
  variables: Record<string, string>;
  only: "requests" | "flows" | undefined;
  junit: string | undefined;
  start: boolean;
  waitMs: number;
  timeoutMs: number;
}

async function run(io: Io, settings: RunSettings): Promise<number> {
  const started = performance.now();
  const root = await findProjectRoot(settings.folder);
  if (!root) {
    io.stderr(
      `No .routelens folder in ${settings.folder} or above it. Open the project in VS Code with RouteLens once, or add requests to .routelens/requests.\n`,
    );
    return 2;
  }
  const environmentName = settings.environmentName ?? DEFAULT_ENVIRONMENT;
  const environment = await readEnvironment(root, environmentName);
  if (!environment && settings.environmentName !== undefined) {
    io.stderr(
      `No environment "${environmentName}" (.routelens/environments/${environmentName}.env.json).\n`,
    );
    return 2;
  }
  const variables = { ...environment?.variables, ...envVariables(io.env), ...settings.variables };
  const relative = (file: string): string => path.relative(root, file).split(path.sep).join("/");

  // Read everything first, so a broken file is reported, not skipped.
  const requests: Array<{ file: string; request: ApiRequest; method: ApiRequest["method"] }> = [];
  const requestResults: RequestResult[] = [];
  if (settings.only !== "flows") {
    for (const file of await listRequestFiles(root)) {
      try {
        const request = await readRequestFile(file);
        requests.push({ file, request, method: request.method });
      } catch (error) {
        requestResults.push({ file: relative(file), run: undefined, problem: messageOf(error) });
      }
    }
  }
  const flowFiles = settings.only === "requests" ? [] : await listFlowFiles(root);
  if (requests.length + requestResults.length + flowFiles.length === 0) {
    io.stderr(
      `Nothing to run: ${relative(path.join(root, ".routelens"))} has no requests or flows.\n`,
    );
    return 2;
  }

  io.stdout(
    `RouteLens ${VERSION} · ${root} · environment "${environment ? environmentName : "(none)"}"\n`,
  );
  const server = await ensureServer(io, root, requests, variables, settings);
  if (server === null) return 2;
  try {
    const login = findLoginRequest(requests);
    const password = io.env.ROUTELENS_PASSWORD;
    const auth =
      login && password !== undefined
        ? new AuthSession(login, async () => ({
            password,
            ...(io.env.ROUTELENS_USERNAME === undefined
              ? {}
              : { username: io.env.ROUTELENS_USERNAME }),
          }))
        : undefined;
    const options = {
      variables,
      send: { timeoutMs: settings.timeoutMs },
      ...(auth ? { auth } : {}),
    };

    if (requests.length + requestResults.length > 0) io.stdout("\nRequests\n");
    for (const item of requestResults) io.stdout(`  ✗ ${item.file}\n      ${item.problem}\n`);
    for (const { file, request } of orderForRun(requests)) {
      const result = await runRequest(request, { ...options, file });
      requestResults.push({ file: relative(file), run: result });
      io.stdout(requestLines(result, relative(file)));
      annotate(io, relative(file), result);
    }

    const flowResults: FlowResult[] = [];
    if (flowFiles.length > 0) io.stdout("\nFlows\n");
    for (const file of flowFiles) {
      let flow;
      try {
        flow = await readFlowFile(file);
      } catch (error) {
        flowResults.push({
          file: relative(file),
          name: path.basename(file),
          run: undefined,
          problem: messageOf(error),
        });
        io.stdout(`  ✗ ${relative(file)}\n      ${messageOf(error)}\n`);
        continue;
      }
      const result = await runFlow(flow, { ...options, root, file });
      flowResults.push({ file: relative(file), name: flow.name, run: result });
      const total = result.steps.length + result.skipped.length;
      io.stdout(
        `  ${result.passed ? "✓" : "✗"} ${flow.name} · ${total === 1 ? "1 step" : `${total} steps`} · ${duration(result.durationMs)}\n`,
      );
      if (!result.passed) {
        for (const step of result.steps) {
          io.stdout(
            `      ${step.passed ? "✓" : "✗"} ${step.index + 1}. ${step.name}${step.response ? ` · ${step.response.status}` : ""}\n`,
          );
          if (!step.passed) io.stdout(problemLines(step, "          "));
        }
        result.skipped.forEach((name, offset) =>
          io.stdout(`      – ${result.steps.length + offset + 1}. ${name} (not run)\n`),
        );
        const failed = result.steps.find((step) => !step.passed);
        if (failed) annotate(io, relative(file), failed, `${flow.name} › ${failed.name}`);
      }
    }

    const passed =
      requestResults.filter((item) => item.run?.passed).length +
      flowResults.filter((item) => item.run?.passed).length;
    const failed = requestResults.length + flowResults.length - passed;
    const durationMs = performance.now() - started;
    io.stdout(
      `\n${passed} passed${failed > 0 ? `, ${failed} failed` : ""} · ${duration(durationMs)}\n`,
    );
    if (!auth && login && requestResults.some((item) => item.run?.response?.status === 401)) {
      io.stdout(
        `Some routes answered 401. Set ROUTELENS_USERNAME and ROUTELENS_PASSWORD to log in with ${login.request.method} ${login.request.url}.\n`,
      );
    }
    if (settings.junit) {
      await writeFile(settings.junit, toJUnit(requestResults, flowResults, durationMs), "utf8");
      io.stdout(`JUnit report: ${settings.junit}\n`);
    }
    return failed > 0 ? 1 : 0;
  } finally {
    await server?.stop();
  }
}

/**
 * The local server must answer before anything runs. Returns the server RouteLens started
 * (stopped at the end), `undefined` when none was needed, or `null` when it is not there.
 */
async function ensureServer(
  io: Io,
  root: string,
  requests: ReadonlyArray<{ request: ApiRequest }>,
  variables: Record<string, string>,
  settings: RunSettings,
): Promise<DevServer | undefined | null> {
  const urls = requests.flatMap(({ request }) => {
    try {
      return [resolveRequest(request, variables).request.url];
    } catch {
      return [];
    }
  });
  const url = urls.find((item) => localServerOf(item)) ?? variables.baseUrl;
  const target = url ? localServerOf(url) : undefined;
  if (!target || (await isPortOpen(target.port, { host: target.host }))) return undefined;

  const where = `${target.host}:${target.port}`;
  if (settings.start) {
    const start = (await detectServer(root))?.start;
    if (!start) {
      io.stderr(
        `Nothing answers on ${where}, and package.json has no dev or start script to start it with.\n`,
      );
      return null;
    }
    io.stdout(`Starting the dev server: ${start.command} (in ${start.cwd})\n`);
    const server = startDevServer(start, target, settings.waitMs);
    try {
      await server.ready;
      io.stdout(`The server answers on ${where}.\n`);
      return server;
    } catch (error) {
      await server.stop();
      io.stderr(
        `${messageOf(error)}\n${server
          .output()
          .map((line) => `  | ${line}\n`)
          .join("")}`,
      );
      return null;
    }
  }
  if (settings.waitMs > 0) {
    try {
      await waitForPort(target.port, { host: target.host, timeoutMs: settings.waitMs });
      return undefined;
    } catch (error) {
      if (!(error instanceof RouteLensError)) throw error;
    }
  }
  io.stderr(`Nothing answers on ${where}. Start your server first, or run with --start.\n`);
  return null;
}

/** `✓ Create post · 201 Created · 14 ms`, with the reasons below a failure. */
function requestLines(run: RequestRun, file: string): string {
  const status = run.response
    ? ` · ${run.response.status}${run.response.statusText ? ` ${run.response.statusText}` : ""} · ${duration(run.response.durationMs)}`
    : "";
  const login = run.loggedIn ? " · logged in" : "";
  const head = `  ${run.passed ? "✓" : "✗"} ${run.name}${status}${login}\n`;
  return run.passed
    ? head
    : `${head}      ${file} · ${run.method} ${run.url}\n${problemLines(run, "      ")}`;
}

function problemLines(run: RequestRun, indent: string): string {
  if (run.error) return `${indent}${run.error.message}\n`;
  return run.checks
    .filter((check) => !check.passed)
    .map((check) => `${indent}✗ ${checkText(check)}\n`)
    .join("");
}

/** In GitHub Actions, failures also show up on the files in the pull request. */
function annotate(io: Io, file: string, run: RequestRun, title = run.name): void {
  if (io.env.GITHUB_ACTIONS !== "true" || run.passed) return;
  const reason =
    run.error?.message ??
    run.checks
      .filter((check) => !check.passed)
      .map(checkText)
      .join("; ");
  const clean = (text: string): string =>
    text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  io.stdout(
    `::error file=${clean(file)},title=${clean(`RouteLens: ${title}`)}::${clean(reason)}\n`,
  );
}

function checkText(check: CheckResult): string {
  return check.detail ? `${check.label}: ${check.detail}` : check.label;
}

/** `--var name=value` → { name: value }. `undefined` (after a message) when one is malformed. */
function parseVars(items: readonly string[], io: Io): Record<string, string> | undefined {
  const variables: Record<string, string> = {};
  for (const item of items) {
    const at = item.indexOf("=");
    if (at <= 0) {
      io.stderr(`--var takes name=value, not "${item}".\n`);
      return undefined;
    }
    variables[item.slice(0, at)] = item.slice(at + 1);
  }
  return variables;
}

/** `ROUTELENS_VAR_token=x` → { token: "x" }: how CI passes secrets without writing them to files. */
function envVariables(env: Io["env"]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("ROUTELENS_VAR_") && value !== undefined && name.length > 14) {
      variables[name.slice(14)] = value;
    }
  }
  return variables;
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
