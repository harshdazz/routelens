import { access } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AuthSession,
  HTTP_METHODS,
  RouteLensError,
  detectServer,
  expectSchema,
  findLoginRequest,
  flowFilePath,
  isPortOpen,
  localServerOf,
  matchRoute,
  orderForRun,
  parseFlow,
  readFlowFile,
  requestSchema,
  resolveRequest,
  runFlow,
  runRequest,
  writeFlowFile,
  type ApiRequest,
  type Credentials,
  type DetectedRoute,
  type Flow,
  type FlowInput,
  type FlowRun,
  type RequestRun,
  type ResolvedRequest,
  type RunOptions,
} from "@routelens/core";
import { resultLine, routeSource, routeText, runDetails, sentRequest } from "./format.js";
import { createGuard } from "./guard.js";
import { Project, messageOf, type ProjectEnvironment, type RunItem } from "./project.js";

export interface RouteLensServerOptions {
  /** The project folder. */
  root: string;
  /** Default environment for every tool (default `local`). */
  environment?: string;
  /** Hosts the person allowed besides this machine and the environment files (`--allow-host`). */
  allowHosts?: readonly string[];
  /** Writes to non-local hosts without asking (`--allow-remote-writes`). */
  allowRemoteWrites?: boolean;
  timeoutMs?: number;
  /** Auto-login credentials, from ROUTELENS_USERNAME / ROUTELENS_PASSWORD. Never a tool input. */
  credentials?: Credentials;
  version?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const INSTRUCTIONS = `RouteLens tests this project's HTTP API with plain code: it reads the routes from the code (Next.js and Express), sends requests and checks the responses.

A good way to "test the API and fix what's broken":
1. list_routes: the routes, where their handlers are, and the saved requests and flows.
2. run_all: run everything. Each result says passed or failed.
3. get_last_failure: what was sent, what came back, which check failed, and the code of the route it belongs to.
4. read_route_source: more of a route's code, and the zod schema it validates with.
5. Fix the code, then send_request or run_all again to confirm.

The dev server must be running: RouteLens never starts it. If nothing answers, ask the person to start it (the tool says which command).
Requests only go to this machine or to hosts in the project's environment files; POST, PUT, PATCH and DELETE to other hosts need the person's OK.
A flow (.flow.json) is a list of requests run in order, with values passed on (extract) and checks (expect). Write one with run_flow (try it), then save_flow.`;

const FLOW_EXAMPLE = `{ "version": 1, "name": "Create and read a post", "steps": [
  { "request": "create-post", "extract": { "postId": "body.id" }, "expect": { "status": 201 } },
  { "name": "Read it", "request": { "method": "GET", "url": "{{baseUrl}}/api/posts/{{postId}}" },
    "expect": { "status": 200, "values": { "body.id": "{{postId}}", "body.title": { "type": "string" } } } } ] }`;

const environmentInput = z
  .string()
  .optional()
  .describe('Environment name from .routelens/environments (default "local").');

/** One failed request, kept for get_last_failure. */
interface Failure {
  name: string;
  /** Which tool call or flow step it came from. */
  where: string;
  run: RequestRun;
  sent: ResolvedRequest | undefined;
  route: DetectedRoute | undefined;
}

/** The RouteLens MCP server (ADR-0009). Connect it to a transport (stdio in bin.ts). */
export function createServer(options: RouteLensServerOptions): McpServer {
  const server = new McpServer(
    { name: "routelens", title: "RouteLens", version: options.version ?? "0.0.0" },
    { instructions: INSTRUCTIONS },
  );
  const project = new Project(options.root);
  let failures: Failure[] = [];
  const lastResults = new Map<string, string>();
  const logins = new Map<string, AuthSession>();

  /** Ask the person through the agent's app (MCP elicitation). `undefined`: it can't ask. */
  const ask = async (message: string): Promise<boolean | undefined> => {
    if (!server.server.getClientCapabilities()?.elicitation) return undefined;
    try {
      const reply = await server.server.elicitInput({
        message,
        requestedSchema: {
          type: "object",
          properties: {
            allow: { type: "boolean", title: "Allow", description: "Send these requests" },
          },
          required: ["allow"],
        },
      });
      return reply.action === "accept" && reply.content?.allow === true;
    } catch {
      return undefined;
    }
  };

  /** What every run needs: the environment, the routes, the requests, and the guard rails. */
  const prepare = async (environmentName: string | undefined) => {
    const environment = await project.environment(environmentName ?? options.environment);
    const scan = await project.scan();
    const { items, broken } = await project.runItems(scan.routes);
    const guard = createGuard({
      environmentOrigins: await project.environmentOrigins(),
      allowHosts: options.allowHosts ?? [],
      allowRemoteWrites: options.allowRemoteWrites ?? false,
      ask,
    });
    let lastSent: ResolvedRequest | undefined;
    const runOptions: RunOptions = {
      variables: environment.variables,
      send: {
        timeoutMs: options.timeoutMs ?? 30_000,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
      beforeSend: async (request) => {
        lastSent = request;
        await guard(request);
      },
    };
    const auth = loginFor(environment.name, items);
    if (auth) runOptions.auth = auth;
    return {
      environment,
      routes: scan.routes,
      scan,
      items,
      broken,
      runOptions,
      /** The last request the runner sent (or tried to), then forget it. */
      takeSent: (): ResolvedRequest | undefined => {
        const sent = lastSent;
        lastSent = undefined;
        return sent;
      },
    };
  };

  /** One login session per environment, kept between tool calls so the token is reused. */
  const loginFor = (environment: string, items: readonly RunItem[]): AuthSession | undefined => {
    const credentials = options.credentials;
    if (!credentials) return undefined;
    const login = findLoginRequest(items);
    if (!login) return undefined;
    const key = `${environment}\0${login.request.method} ${login.request.url}`;
    let session = logins.get(key);
    if (!session) {
      session = new AuthSession(login, async () => credentials);
      logins.set(key, session);
    }
    session.clearFailure();
    return session;
  };

  /** `undefined` when the local server answers (or the URL is not local); else why not. */
  const serverDown = async (urls: readonly string[]): Promise<string | undefined> => {
    const target = urls.map((url) => localServerOf(url)).find((item) => item !== undefined);
    if (!target || (await isPortOpen(target.port, { host: target.host }))) return undefined;
    const start = (await detectServer(project.root).catch(() => undefined))?.start;
    return `Nothing answers on ${target.host}:${target.port}: the dev server is not running. RouteLens never starts it. Ask the person to start it${start ? ` (\`${start.command}\` in ${start.cwd})` : ""}, then try again.`;
  };

  const record = (
    run: RequestRun,
    name: string,
    item: { route?: DetectedRoute | undefined },
    routes: readonly DetectedRoute[],
  ) => {
    lastResults.set(name, resultLine(run));
    return item.route ?? matchRoute(routes, run.method, run.url);
  };

  server.registerTool(
    "list_routes",
    {
      title: "List API routes",
      description:
        "List the project's API routes found in the code (method, path, handler file:line, sample body from the zod schema), the saved requests, the flows and the server address. Start here.",
      inputSchema: { environment: environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ environment: environmentName }) =>
      guarded(async () => {
        const environment = await project.environment(environmentName ?? options.environment);
        const scan = await project.scan();
        const { items, broken } = await project.runItems(scan.routes);
        const flows = await project.flows();
        return json({
          project: project.root,
          environment: environmentSummary(environment),
          frameworks: scan.frameworks,
          routes: scan.routes.map((route) => {
            const saved = items.find((item) => item.file && item.route?.key === route.key);
            const last = lastResults.get(saved?.name ?? route.key);
            return {
              route: route.key,
              source: `${route.file}:${route.line}`,
              request: saved?.name ?? null,
              ...(route.anyMethod ? { note: "The handler answers every method." } : {}),
              ...(route.body
                ? {
                    sampleBody: route.body.sample,
                    bodyFrom:
                      route.body.from === "zod"
                        ? `zod schema${route.body.schema ? ` ${route.body.schema.name} (${route.body.schema.file}:${route.body.schema.line})` : ""}`
                        : "fields the handler reads (no zod schema)",
                    ...(route.body.exact ? {} : { sampleMayBeRejected: route.body.notes }),
                  }
                : {}),
              ...(last ? { lastResult: last } : {}),
            };
          }),
          otherSavedRequests: items
            .filter((item) => item.file && !item.route)
            .map((item) => ({
              name: item.name,
              request: `${item.request.method} ${item.request.url}`,
              ...(lastResults.has(item.name) ? { lastResult: lastResults.get(item.name) } : {}),
            })),
          flows: flows.map((flow) => flow.name),
          ...(scan.skipped.length > 0
            ? {
                couldNotRead: scan.skipped.map((item) => ({
                  source: `${item.file}:${item.line}`,
                  reason: item.reason,
                })),
              }
            : {}),
          ...(broken.length > 0 ? { brokenRequestFiles: broken } : {}),
        });
      }),
  );

  server.registerTool(
    "read_route_source",
    {
      title: "Read a route's code",
      description:
        "Show the code of a route handler with line numbers (an arrow marks the handler's line), and the zod schema it validates its body with. Use it to find why a route fails.",
      inputSchema: {
        route: z
          .string()
          .describe(
            'A route from list_routes, e.g. "GET /api/todos/:id". A path ("/api/todos/:id") or a URL path ("GET /api/todos/7") works too.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ route: wanted }) =>
      guarded(async () => {
        const { routes } = await project.scan();
        const route = findRoute(routes, wanted);
        if (!route)
          return problem(
            `No route "${wanted}". Routes: ${routes.map((item) => item.key).join(", ") || "none found"}.`,
          );
        return text(await routeSource(project, route));
      }),
  );

  server.registerTool(
    "send_request",
    {
      title: "Send a request",
      description:
        "Send one request and check the response. Give exactly one of: request (a saved request's name), route (a route from list_routes: its saved request, or a sample made from the code), or url (with method) for a request you write. With request or route, body/headers/query replace or add to the saved ones. Returns the status, headers, body and checks; without expect, a status below 400 passes.",
      inputSchema: {
        request: z.string().optional().describe("A saved request's name from list_routes."),
        route: z.string().optional().describe('A route from list_routes, e.g. "POST /api/todos".'),
        method: z.enum(HTTP_METHODS).optional().describe("With url. Default GET."),
        url: z
          .string()
          .optional()
          .describe('Full URL; may use {{variables}}, e.g. "{{baseUrl}}/api/todos/1".'),
        headers: z.record(z.string(), z.string()).optional(),
        query: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional().describe("A JSON body."),
        expect: expectSchema.optional(),
        environment: environmentInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) =>
      guarded(async () => {
        const given = [input.request, input.route, input.url].filter(
          (value) => value !== undefined,
        );
        if (given.length !== 1) {
          return problem(
            'Give exactly one of request (a saved request name), route (e.g. "POST /api/posts") or url (with method).',
          );
        }
        const context = await prepare(input.environment);
        let item: RunItem | undefined;
        if (input.request !== undefined) {
          item = context.items.find(
            (candidate) => candidate.file && candidate.name === input.request,
          );
          if (!item) {
            const names = context.items
              .filter((candidate) => candidate.file)
              .map((candidate) => candidate.name);
            return problem(
              `No saved request "${input.request}". Saved requests: ${names.join(", ") || "none"}.`,
            );
          }
        } else if (input.route !== undefined) {
          const route = findRoute(context.routes, input.route);
          item = route && context.items.find((candidate) => candidate.route?.key === route.key);
          if (!item) {
            return problem(
              `No route "${input.route}". Routes: ${context.routes.map((route) => route.key).join(", ") || "none found"}.`,
            );
          }
        } else {
          const method = input.method ?? "GET";
          item = {
            name: `${method} ${input.url}`,
            file: undefined,
            request: requestSchema.parse({
              version: 1,
              name: `${method} ${input.url}`,
              method,
              url: input.url,
            }),
            route: undefined,
          };
        }
        const request: ApiRequest = {
          ...item.request,
          headers: { ...item.request.headers, ...input.headers },
          query: { ...item.request.query, ...input.query },
          ...(input.body === undefined ? {} : { body: { type: "json", content: input.body } }),
        };

        const down = await serverDown([safeUrl(request, context.runOptions.variables)]);
        if (down) return problem(down);
        const run = await runRequest(request, {
          ...context.runOptions,
          ...(item.file ? { file: item.file } : {}),
          ...(input.expect ? { expect: input.expect } : {}),
        });
        const sent = context.takeSent();
        const route = record(run, item.name, item, context.routes);
        failures = run.passed ? [] : [{ name: item.name, where: "send_request", run, sent, route }];
        // Agents probe bad input on purpose; without expect, the right 400 still reads as ✗.
        const status = run.response?.status ?? 0;
        const expected = input.expect ?? request.expect;
        const hint =
          !expected && status >= 400 && status < 500
            ? `If this ${status} is what the API should answer, send again with expect: { "status": ${status} } and it counts as passed.`
            : undefined;
        return json({ ...runDetails(run, route), ...(hint ? { hint } : {}) });
      }),
  );

  server.registerTool(
    "run_all",
    {
      title: "Run everything",
      description:
        "Run every saved request, a sample request for every route without one, and every flow, like the Test Everything button. Reads run first, deletes last. Returns passed/failed for each; then call get_last_failure for details.",
      inputSchema: {
        environment: environmentInput,
        only: z.enum(["requests", "flows"]).optional().describe("Run only requests or only flows."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ environment: environmentName, only }) =>
      guarded(async () => {
        const started = performance.now();
        const context = await prepare(environmentName);
        const urls = context.items.map((item) =>
          safeUrl(item.request, context.runOptions.variables),
        );
        const down = await serverDown([...urls, context.runOptions.variables.baseUrl ?? ""]);
        if (down) return problem(down);

        const found: Failure[] = [];
        const results: Array<Record<string, unknown>> = [];
        if (only !== "flows") {
          for (const broken of context.broken) {
            results.push({
              name: broken.file,
              kind: "request",
              passed: false,
              result: `✗ ${broken.problem}`,
            });
          }
          for (const item of orderForRun(
            context.items.map((entry) => ({ ...entry, method: entry.request.method })),
          )) {
            const run = await runRequest(item.request, {
              ...context.runOptions,
              ...(item.file ? { file: item.file } : {}),
            });
            const sent = context.takeSent();
            const route = record(run, item.name, item, context.routes);
            results.push({
              name: item.name,
              kind: item.file ? "saved request" : "route (sample request)",
              passed: run.passed,
              result: resultLine(run),
              ...(route ? { route: routeText(route) } : {}),
            });
            if (!run.passed) found.push({ name: item.name, where: "run_all", run, sent, route });
          }
        }
        if (only !== "requests") {
          for (const { name, file } of await project.flows()) {
            let flow: Flow;
            try {
              flow = await readFlowFile(file);
            } catch (error) {
              results.push({ name, kind: "flow", passed: false, result: `✗ ${messageOf(error)}` });
              continue;
            }
            const flowRun = await runOneFlow(flow, file, context, found, `flow "${flow.name}"`);
            results.push({ name, kind: "flow", passed: flowRun.passed, result: flowLine(flowRun) });
          }
        }
        failures = found;
        const passed = results.filter((item) => item.passed).length;
        return json({
          environment: environmentSummary(context.environment),
          passed,
          failed: results.length - passed,
          durationMs: Math.round(performance.now() - started),
          results,
          next:
            found.length > 0
              ? "Call get_last_failure to see the first failure: what was sent, what came back, and the route's code."
              : results.length === passed
                ? "Everything passed."
                : "Some files could not be read; see the results.",
        });
      }),
  );

  server.registerTool(
    "run_flow",
    {
      title: "Run a flow",
      description: `Run a flow: requests in order, values passed on with extract, checks with expect. Give flow (a saved flow's name from list_routes) or definition (a flow you write, to try it before save_flow). A step's request is a saved request's name or an inline request. Example definition: ${FLOW_EXAMPLE}`,
      inputSchema: {
        flow: z.string().optional().describe("A saved flow's name from list_routes."),
        definition: z
          .unknown()
          .optional()
          .describe("A flow in the .flow.json format (see the example)."),
        environment: environmentInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ flow: flowName, definition, environment: environmentName }) =>
      guarded(async () => {
        if ((flowName === undefined) === (definition === undefined)) {
          return problem(
            "Give either flow (a saved flow's name) or definition (a flow you write).",
          );
        }
        let flow: Flow;
        let file: string | undefined;
        if (flowName !== undefined) {
          const saved = (await project.flows()).find((item) => item.name === flowName);
          if (!saved) {
            const names = (await project.flows()).map((item) => item.name);
            return problem(`No flow "${flowName}". Flows: ${names.join(", ") || "none"}.`);
          }
          file = saved.file;
          flow = await readFlowFile(saved.file);
        } else {
          flow = parseFlow(JSON.stringify(definition), "The flow");
        }
        const context = await prepare(environmentName);
        const down = await serverDown([context.runOptions.variables.baseUrl ?? ""]);
        if (down) return problem(down);
        const found: Failure[] = [];
        const flowRun = await runOneFlow(flow, file, context, found, `flow "${flow.name}"`);
        failures = found;
        return json({
          flow: flow.name,
          passed: flowRun.passed,
          result: flowLine(flowRun),
          steps: flowRun.steps.map((step) => ({
            step: step.index + 1,
            name: step.name,
            passed: step.passed,
            result: resultLine(step),
            ...(step.passed
              ? {}
              : {
                  checks: step.checks.map(
                    (check) =>
                      `${check.passed ? "✓" : "✗"} ${check.label}${check.detail ? `: ${check.detail}` : ""}`,
                  ),
                }),
            ...(Object.keys(step.extracted).length > 0 ? { extracted: step.extracted } : {}),
          })),
          ...(flowRun.skipped.length > 0 ? { notRun: flowRun.skipped } : {}),
          ...(found.length > 0
            ? { next: "Call get_last_failure for the failing step's details." }
            : {}),
        });
      }),
  );

  server.registerTool(
    "save_flow",
    {
      title: "Save a flow",
      description: `Save a flow to .routelens/flows/<name>.flow.json, where the person reviews it and RouteLens, the CLI and CI replay it. Try it with run_flow first. Refuses to replace an existing flow unless overwrite is true. Example definition: ${FLOW_EXAMPLE}`,
      inputSchema: {
        name: z.string().min(1).describe('File name, e.g. "create-and-read-post".'),
        definition: z.unknown().describe("The flow in the .flow.json format."),
        overwrite: z.boolean().optional().describe("Replace an existing flow with this name."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, definition, overwrite }) =>
      guarded(async () => {
        parseFlow(JSON.stringify(definition), "The flow"); // explains every problem
        const file = flowFilePath(project.root, name);
        if (!overwrite && (await exists(file))) {
          return problem(
            `${project.relative(file)} already exists. Pass overwrite: true to replace it.`,
          );
        }
        await writeFlowFile(file, definition as FlowInput);
        return json({
          saved: project.relative(file),
          next: `Run it with run_flow { "flow": "${project
            .relative(file)
            .replace(/^\.routelens\/flows\//, "")
            .replace(/\.flow\.json$/, "")}" }.`,
        });
      }),
  );

  server.registerTool(
    "get_last_failure",
    {
      title: "Get the last failure",
      description:
        "Details of the last failed request from send_request, run_all or run_flow: what was sent, the response (status, headers, body), the failed checks, and the code of the route it belongs to. Use name to pick another failure from the same run.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Another failure from the last run, by the name in its results."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) =>
      guarded(async () => {
        if (failures.length === 0) {
          return json({
            failure: null,
            note: "The last run had no failures (or nothing has run yet). Use run_all to test everything.",
          });
        }
        const failure =
          name === undefined ? failures[0] : failures.find((item) => item.name === name);
        if (!failure) {
          return problem(
            `No failure "${name}" in the last run. Failures: ${failures.map((item) => item.name).join(", ")}.`,
          );
        }
        const others = failures.filter((item) => item !== failure).map((item) => item.name);
        const details = {
          failed: failure.name,
          in: failure.where,
          ...(failure.sent ? { sent: sentRequest(failure.sent) } : {}),
          ...runDetails(failure.run, failure.route),
          ...(others.length > 0 ? { otherFailures: others } : {}),
          next: failure.route
            ? "The route's code follows. Fix the cause, then run send_request or run_all again to check."
            : "No route in the code matches this request; check the URL and the saved request.",
        };
        return failure.route
          ? json(details, await routeSource(project, failure.route))
          : json(details);
      }),
  );

  /** Run a flow, remembering each failed step with the request it sent. */
  async function runOneFlow(
    flow: Flow,
    file: string | undefined,
    context: Awaited<ReturnType<typeof prepare>>,
    found: Failure[],
    where: string,
  ): Promise<FlowRun> {
    const flowRun = await runFlow(flow, {
      ...context.runOptions,
      root: project.root,
      ...(file ? { file } : {}),
      onStep: (step) => {
        const sent = context.takeSent();
        const route = matchRoute(context.routes, step.method, step.url);
        lastResults.set(`${flow.name} › ${step.name}`, resultLine(step));
        if (!step.passed) {
          found.push({
            name: `${flow.name} › ${step.name}`,
            where: `${where}, step ${step.index + 1}`,
            run: step,
            sent,
            route,
          });
        }
      },
    });
    lastResults.set(flow.name, flowLine(flowRun));
    return flowRun;
  }

  return server;
}

/** A route by key ("GET /api/todos/:id"), by path when only one route has it, or by a URL path. */
export function findRoute(
  routes: readonly DetectedRoute[],
  wanted: string,
): DetectedRoute | undefined {
  const text = wanted.trim();
  const [first = "", ...rest] = text.split(/\s+/);
  const method = rest.length > 0 ? first.toUpperCase() : undefined;
  const routePath = rest.length > 0 ? rest.join(" ") : first;
  const exact = routes.find(
    (route) => route.path === routePath && (!method || route.method === method),
  );
  if (exact && (method || routes.filter((route) => route.path === routePath).length === 1))
    return exact;
  return method ? matchRoute(routes, method, routePath) : undefined;
}

function flowLine(run: FlowRun): string {
  const total = run.steps.length + run.skipped.length;
  if (run.passed)
    return `✓ ${total === 1 ? "1 step" : `${total} steps`} · ${Math.round(run.durationMs)} ms`;
  const step = run.steps.at(-1);
  return step
    ? `✗ step ${step.index + 1} of ${total} "${step.name}": ${resultLine(step)}`
    : "✗ failed";
}

function environmentSummary(environment: ProjectEnvironment): Record<string, unknown> {
  return {
    name: environment.name,
    baseUrl: environment.variables.baseUrl ?? null,
    from: environment.from,
  };
}

/** The request's URL with variables filled in, or the URL as written. */
function safeUrl(request: ApiRequest, variables: Readonly<Record<string, string>>): string {
  try {
    return resolveRequest(request, variables).request.url;
  } catch {
    return request.url;
  }
}

function json(value: unknown, ...more: string[]): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(value, null, 2) },
      ...more.map((item) => ({ type: "text" as const, text: item })),
    ],
  };
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function problem(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** RouteLens errors (a bad file, an unknown environment) become a readable tool error. */
async function guarded(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RouteLensError) {
      return problem([error.message, ...error.details.map((line) => `- ${line}`)].join("\n"));
    }
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
