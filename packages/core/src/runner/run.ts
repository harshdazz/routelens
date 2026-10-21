import { RouteLensError, type RouteLensErrorCode } from "../errors.js";
import {
  requestSchema,
  type ApiRequest,
  type Expectation,
  type Flow,
  type FlowStep,
  type HttpMethod,
} from "../model.js";
import {
  fillJsonValue,
  resolveRequest,
  valuesAsText,
  type ResolvedRequest,
  type TypedValues,
} from "../resolve.js";
import { sendRequest, type ApiResponse, type SendOptions } from "../send.js";
import { readRequestFile, savedRequestPath } from "../storage.js";
import type { Variables } from "../variables.js";
import type { AuthSession } from "./auth.js";
import { checkResponse, expects401, responseSubject, type CheckResult } from "./expect.js";
import { readValuePath } from "./valuePath.js";

// The runner (ADR-0008): runs requests and flows with plain code, no AI. The extension, the
// CLI and the MCP server all use it, so they agree on what "passed" means.

export interface RunOptions {
  /** The environment's variables (`{{baseUrl}}`). */
  variables: Variables;
  send?: SendOptions;
  /** Log in when the server answers 401, and reuse the token. */
  auth?: AuthSession;
  /** Send even when `{{variables}}` are missing (the person said "Send anyway"). */
  allowMissingVariables?: boolean;
}

/** The result of one request: what was sent, what came back and every check. */
export interface RequestRun {
  name: string;
  method: HttpMethod;
  /** The URL that was sent, or the URL as written when it could not be resolved. */
  url: string;
  response?: ApiResponse;
  /** Set when nothing came back: a network error, a timeout, a bad URL. */
  error?: { code: RouteLensErrorCode; message: string };
  checks: CheckResult[];
  passed: boolean;
  /** RouteLens logged in before sending (or sending again). */
  loggedIn: boolean;
  /** Why auto-login did not work, when the server answered 401. */
  loginProblem?: string;
  durationMs: number;
}

export interface StepRun extends RequestRun {
  /** 0-based position in the flow. */
  index: number;
  /** Values saved by `extract`. */
  extracted: Record<string, unknown>;
}

export interface FlowRun {
  name: string;
  file: string | undefined;
  steps: StepRun[];
  /** Steps not run because an earlier step failed. */
  skipped: string[];
  passed: boolean;
  durationMs: number;
}

/** "Test everything" order: reads first, then writes, deletes last. Stable within a group. */
const METHOD_ORDER: Readonly<Record<HttpMethod, number>> = {
  GET: 0,
  HEAD: 0,
  OPTIONS: 0,
  POST: 1,
  PUT: 2,
  PATCH: 3,
  DELETE: 4,
};

export function orderForRun<T extends { method: HttpMethod }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => METHOD_ORDER[a.item.method] - METHOD_ORDER[b.item.method] || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Send one request and check the response against its `expect` (or status below 400).
 * A 401 from the server RouteLens can log in to triggers one login and one retry, unless
 * the request expects the 401. Cancelling (`send.signal`) throws a RouteLensError "aborted".
 */
export async function runRequest(
  request: ApiRequest,
  options: RunOptions & { file?: string; values?: TypedValues; expect?: Expectation },
): Promise<RequestRun> {
  const started = performance.now();
  const values = options.values ?? {};
  const expectation = options.expect ?? request.expect;
  const run: RequestRun = {
    name: request.name,
    method: request.method,
    url: request.url,
    checks: [],
    passed: false,
    loggedIn: false,
    durationMs: 0,
  };
  const finish = (): RequestRun => ({ ...run, durationMs: performance.now() - started });

  const { auth, variables } = options;
  const allVariables = { ...variables, ...valuesAsText(values) };
  const isLogin = auth?.isLoginRequest(request, options.file) ?? false;
  const useAuth = auth !== undefined && !isLogin && !expects401(expectation);

  try {
    // Running the login request itself logs in, with the person's credentials when they gave them.
    if (auth && isLogin && !expects401(expectation)) {
      const outcome = await auth.logIn(allVariables, options.send, false);
      if (outcome.response) {
        run.response = outcome.response;
        run.loggedIn = outcome.ok;
        return check(run, expectation, allVariables, values, finish);
      }
    }

    const resolved = resolveRequest(request, variables, values);
    run.url = resolved.request.url;
    if (resolved.missingVariables.length > 0 && !options.allowMissingVariables) {
      const names = resolved.missingVariables.map((name) => `{{${name}}}`).join(", ");
      run.error = { code: "invalid-request", message: `${names} not defined.` };
      return finish();
    }

    const send = (target: ResolvedRequest): Promise<ApiResponse> =>
      sendRequest(useAuth ? auth.apply(target) : target, options.send);
    let response = await send(resolved.request);

    if (response.status === 401 && useAuth && auth.covers(run.url, allVariables)) {
      if (auth.failure) {
        run.loginProblem = auth.failure;
      } else {
        // Not logged in yet, or the token expired: log in once and send again.
        auth.logOut();
        const outcome = await auth.logIn(allVariables, options.send);
        if (outcome.ok) {
          run.loggedIn = true;
          response = await send(resolved.request);
        } else {
          run.loginProblem = outcome.reason;
        }
      }
    }
    run.response = response;
    return check(run, expectation, allVariables, values, finish);
  } catch (error) {
    if (error instanceof RouteLensError) {
      if (error.code === "aborted") throw error;
      run.error = { code: error.code, message: error.message };
      return finish();
    }
    throw error;
  }
}

/**
 * Run a flow's steps in order (ADR-0004: plain code, no AI). Values from `extract` feed the
 * next steps; the first failing step stops the flow. `onStep` reports progress.
 */
export async function runFlow(
  flow: Flow,
  options: RunOptions & { root: string; file?: string; onStep?: (step: StepRun) => void },
): Promise<FlowRun> {
  const started = performance.now();
  const variables = { ...options.variables, ...flow.variables };
  const values: Record<string, unknown> = {};
  const steps: StepRun[] = [];
  let failedAt: number | undefined;

  for (const [index, step] of flow.steps.entries()) {
    const loaded = await loadStep(step, options.root);
    let result: StepRun;
    if ("error" in loaded) {
      result = {
        name: step.name ?? (typeof step.request === "string" ? step.request : "step"),
        method: typeof step.request === "string" ? "GET" : step.request.method,
        url: typeof step.request === "string" ? step.request : step.request.url,
        error: { code: "invalid-file", message: loaded.error },
        checks: [],
        passed: false,
        loggedIn: false,
        durationMs: 0,
        index,
        extracted: {},
      };
    } else {
      const run = await runRequest(loaded.request, {
        ...options,
        variables,
        values,
        ...(loaded.file === undefined ? {} : { file: loaded.file }),
        ...(step.expect === undefined ? {} : { expect: step.expect }),
      });
      result = { ...run, name: step.name ?? run.name, index, extracted: {} };
      if (result.passed && run.response) extract(step, run.response, result, values);
    }
    steps.push(result);
    options.onStep?.(result);
    if (!result.passed) {
      failedAt = index;
      break;
    }
  }

  const skipped =
    failedAt === undefined
      ? []
      : flow.steps
          .slice(failedAt + 1)
          .map((step, offset) => stepLabel(step, failedAt + offset + 2));
  return {
    name: flow.name,
    file: options.file,
    steps,
    skipped,
    passed: failedAt === undefined,
    durationMs: performance.now() - started,
  };
}

function check(
  run: RequestRun,
  expectation: Expectation | undefined,
  variables: Variables,
  values: TypedValues,
  finish: () => RequestRun,
): RequestRun {
  if (!run.response) return finish();
  const filled =
    expectation && (fillJsonValue(expectation, variables, values).value as Expectation);
  run.checks = checkResponse(run.response, filled);
  if (run.loginProblem && run.response.status === 401) {
    run.checks.push({ label: "logged in", passed: false, detail: run.loginProblem });
  }
  run.passed = run.checks.every((item) => item.passed);
  return finish();
}

/** Save the step's `extract` values. A missing value fails the step. */
function extract(
  step: FlowStep,
  response: ApiResponse,
  result: StepRun,
  values: Record<string, unknown>,
): void {
  const subject = responseSubject(response);
  for (const [name, path] of Object.entries(step.extract)) {
    const { found, value } = readValuePath(subject, path);
    if (found) {
      values[name] = value;
      result.extracted[name] = value;
    } else {
      result.checks.push({
        label: `save ${path} as {{${name}}}`,
        passed: false,
        detail: `${path} is missing`,
      });
      result.passed = false;
    }
  }
}

async function loadStep(
  step: FlowStep,
  root: string,
): Promise<{ request: ApiRequest; file?: string } | { error: string }> {
  if (typeof step.request !== "string") {
    const { name, ...fields } = step.request;
    return {
      request: requestSchema.parse({
        version: 1,
        name: name ?? `${fields.method} ${fields.url}`,
        ...fields,
      }),
    };
  }
  const file = savedRequestPath(root, step.request);
  if (!file) return { error: `"${step.request}" is not a request in .routelens/requests.` };
  try {
    return { request: await readRequestFile(file), file };
  } catch (error) {
    const missing = (error as { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT";
    return {
      error: missing
        ? `No saved request named "${step.request}" (.routelens/requests/${step.request}.req.json).`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

function stepLabel(step: FlowStep, position: number): string {
  if (step.name) return step.name;
  return typeof step.request === "string"
    ? step.request
    : (step.request.name ?? `step ${position}: ${step.request.method} ${step.request.url}`);
}
