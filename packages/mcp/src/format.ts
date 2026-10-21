import { readFile } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import type { CheckResult, DetectedRoute, RequestRun, ResolvedRequest } from "@routelens/core";
import type { Project } from "./project.js";

// What the agent reads. Results are JSON (every model reads it well); code is plain text with
// line numbers, so the agent can point at the line to change.

/** Bodies longer than this are cut, so one big response doesn't flood the agent's context. */
export const BODY_LIMIT = 20_000;

/** `✓ 201 Created · 14 ms`, `✗ 404 Not Found · 3 ms · status is below 400: got 404 Not Found` */
export function resultLine(run: RequestRun): string {
  if (!run.response) return `✗ ${run.error?.message ?? "failed"}`;
  const { status, statusText, durationMs } = run.response;
  const text = statusText || STATUS_CODES[status] || "";
  const head = `${run.passed ? "✓" : "✗"} ${status}${text ? ` ${text}` : ""} · ${Math.round(durationMs)} ms`;
  const failed = run.checks.find((check) => !check.passed);
  return run.passed || !failed ? head : `${head} · ${checkText(failed)}`;
}

export function checkText(check: CheckResult): string {
  return `${check.passed ? "✓" : "✗"} ${check.label}${check.detail ? `: ${check.detail}` : ""}`;
}

/** `GET /api/todos/:id (src/routes/todos.js:14)` */
export function routeText(route: DetectedRoute | undefined): string | undefined {
  return route ? `${route.key} (${route.file}:${route.line})` : undefined;
}

/** A request as sent (headers RouteLens added for the login are never included). */
export function sentRequest(
  request: ResolvedRequest | undefined,
): Record<string, unknown> | undefined {
  if (!request) return undefined;
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: parseBody(request.body) }),
  };
}

/** The full result of one request, for send_request and get_last_failure. */
export function runDetails(
  run: RequestRun,
  route: DetectedRoute | undefined,
): Record<string, unknown> {
  const response = run.response;
  return {
    passed: run.passed,
    result: resultLine(run),
    request: `${run.method} ${run.url}`,
    ...(route ? { route: routeText(route) } : {}),
    ...(run.error ? { error: run.error } : {}),
    checks: run.checks.map(checkText),
    ...(run.loggedIn ? { loggedIn: "RouteLens logged in first (auto-login)." } : {}),
    ...(run.loginProblem ? { loginProblem: run.loginProblem } : {}),
    ...(response
      ? {
          response: {
            status: response.status,
            statusText: response.statusText || STATUS_CODES[response.status] || "",
            durationMs: Math.round(response.durationMs),
            headers: response.headers,
            body: cutBody(response.body),
          },
        }
      : {}),
  };
}

/**
 * The code around a route handler, with line numbers and an arrow on the handler's line:
 * the whole file when it is short, else the part around the handler. Only project files.
 */
export async function routeSource(project: Project, route: DetectedRoute): Promise<string> {
  const parts = [`${route.key} · ${route.file}:${route.line} (${route.framework})`];
  const handler = await excerpt(project, route.file, route.line, 200, 25, 70);
  parts.push(handler ?? `(could not read ${route.file})`);
  const schema = route.body?.schema;
  if (schema) {
    const code = await excerpt(project, schema.file, schema.line, 0, 2, 25);
    if (code) parts.push(`Body schema ${schema.name} · ${schema.file}:${schema.line}\n${code}`);
  } else if (route.body?.from === "fields") {
    parts.push(
      `No zod schema: the handler reads these body fields: ${Object.keys(asObject(route.body.sample)).join(", ")}`,
    );
  }
  return parts.join("\n\n");
}

async function excerpt(
  project: Project,
  relative: string,
  line: number,
  wholeFileUpTo: number,
  before: number,
  after: number,
): Promise<string | undefined> {
  const file = project.insideRoot(relative);
  if (!file) return undefined;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  const whole = lines.length <= wholeFileUpTo;
  const first = whole ? 1 : Math.max(1, line - before);
  const last = whole ? lines.length : Math.min(lines.length, line + after);
  const width = String(last).length;
  const numbered = lines.slice(first - 1, last).map((content, index) => {
    const number = first + index;
    return `${number === line ? "→" : " "}${String(number).padStart(width)} | ${content}`;
  });
  return `${relative}${whole ? "" : ` (lines ${first}-${last} of ${lines.length})`}\n${numbered.join("\n")}`;
}

function cutBody(body: string): unknown {
  const parsed = parseBody(body);
  if (typeof parsed !== "string") {
    const text = JSON.stringify(parsed);
    return text.length <= BODY_LIMIT
      ? parsed
      : `${text.slice(0, BODY_LIMIT)}… (cut: ${text.length} characters)`;
  }
  return parsed.length <= BODY_LIMIT
    ? parsed
    : `${parsed.slice(0, BODY_LIMIT)}… (cut: ${parsed.length} characters)`;
}

function parseBody(body: string): unknown {
  if (body.trim() === "") return "";
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
