import { STATUS_CODES } from "node:http";
import type { CheckResult, RequestRun, RouteLensErrorCode, StepRun } from "@routelens/core";
import {
  formatDuration,
  prettyBody,
  type ErrorView,
  type FlowView,
  type ResponseView,
} from "./responseHtml";

// Text for the inline result shown next to "▶ Send request" and "▶ Run flow". No `vscode`
// import, so it can be unit-tested.

/** The last thing that happened to a request or flow file. */
export type LastResult =
  | { kind: "sending" }
  | { kind: "response"; view: ResponseView }
  | { kind: "error"; view: ErrorView; code: RouteLensErrorCode | undefined }
  | { kind: "flow"; view: FlowView };

const PREVIEW_CHARS = 600;

/** The result of a run, as the inline result and the panel show it. */
export function runToResult(run: RequestRun, environmentName: string | undefined): LastResult {
  if (run.response) {
    return {
      kind: "response",
      view: {
        requestName: run.name,
        method: run.method,
        url: run.url,
        environmentName,
        response: run.response,
        checks: run.checks,
        loggedIn: run.loggedIn,
      },
    };
  }
  const code = run.error?.code;
  return {
    kind: "error",
    code,
    view: {
      requestName: run.name,
      method: run.method,
      url: run.url,
      message: run.error?.message ?? "The request failed.",
      hint: hintFor(code),
    },
  };
}

/** Did it pass? `undefined` while sending. Without checks, a status below 400 passes. */
export function resultPassed(result: LastResult): boolean | undefined {
  switch (result.kind) {
    case "sending":
      return undefined;
    case "response":
      return result.view.checks
        ? result.view.checks.every((check) => check.passed)
        : result.view.response.status < 400;
    case "error":
      return false;
    case "flow":
      return result.view.run.passed;
  }
}

/** `✓ 201 Created · 14 ms`, `✗ 404 Not Found · 3 ms`, `✗ Can't connect`, `✓ 3 steps · 40 ms` */
export function inlineResultTitle(result: LastResult): string {
  switch (result.kind) {
    case "sending":
      return "$(sync~spin) Sending...";
    case "response": {
      const { status, statusText, durationMs } = result.view.response;
      const icon = resultPassed(result) ? "✓" : "✗";
      const text = statusText || STATUS_CODES[status] || "";
      const title = `${icon} ${status}${text ? ` ${text}` : ""} · ${formatDuration(durationMs)}`;
      // The status is already in the title; other failed checks are named.
      const failed = failedChecks(result.view.checks).filter(
        (check) => !check.label.startsWith("status is"),
      );
      if (failed.length === 0) return title;
      return failed.length === 1 && failed[0]
        ? `${title} · failed: ${failed[0].label}`
        : `${title} · ${failed.length} checks failed`;
    }
    case "error":
      return `✗ ${errorLabel(result.code)}`;
    case "flow": {
      const { run } = result.view;
      const total = run.steps.length + run.skipped.length;
      if (run.passed) {
        return `✓ ${total === 1 ? "1 step" : `${total} steps`} · ${formatDuration(run.durationMs)}`;
      }
      const step = run.steps.at(-1);
      if (!step) return "✗ Failed";
      return `✗ Step ${step.index + 1} of ${total} "${step.name}": ${stepProblem(step)}`;
    }
  }
}

/** Hover text: failed checks, then the start of the body (pretty JSON), or the error. */
export function inlineResultTooltip(result: LastResult): string {
  switch (result.kind) {
    case "sending":
      return "Sending the request...";
    case "response": {
      const { response, checks, loggedIn } = result.view;
      const body = prettyBody(response.body, response.headers["content-type"]);
      const preview =
        body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}\n...` : body || "(empty)";
      const notes = [
        ...failedChecks(checks).map((check) => `✗ ${checkLine(check)}`),
        ...(loggedIn ? ["Logged in first."] : []),
      ];
      return `${notes.length > 0 ? `${notes.join("\n")}\n\n` : ""}${preview}\n\nClick to open the full response.`;
    }
    case "error":
      return `${result.view.message}${result.view.hint ? `\n\n${result.view.hint}` : ""}`;
    case "flow": {
      const { run } = result.view;
      const lines = run.steps.map(
        (step) =>
          `${step.passed ? "✓" : "✗"} ${step.index + 1}. ${step.name}${step.response ? ` · ${step.response.status}` : ""}${step.passed ? "" : ` · ${stepProblem(step)}`}`,
      );
      const skipped = run.skipped.map(
        (name, offset) => `– ${run.steps.length + offset + 1}. ${name} (not run)`,
      );
      return `${[...lines, ...skipped].join("\n")}\n\nClick to open the details.`;
    }
  }
}

/** One line for the output channel: `✓ POST http://… · 201 Created · 14 ms`. */
export function runLine(run: RequestRun): string {
  const head = `${run.passed ? "✓" : "✗"} ${run.method} ${run.url}`;
  if (!run.response) return `${head} · ${stepProblem(run)}`;
  const { status, statusText, durationMs } = run.response;
  const text = statusText || STATUS_CODES[status] || "";
  const login = run.loggedIn ? " · logged in" : "";
  const problem = run.passed ? "" : ` · ${stepProblem(run)}`;
  return `${head} · ${status}${text ? ` ${text}` : ""} · ${formatDuration(durationMs)}${login}${problem}`;
}

/** The first reason a step failed: a check with its detail, or the error. */
export function stepProblem(step: RequestRun | StepRun): string {
  if (step.error) return step.error.message;
  const failed = failedChecks(step.checks)[0];
  return failed ? checkLine(failed) : "failed";
}

/** `status is 200: got 404 Not Found` */
export function checkLine(check: CheckResult): string {
  return check.detail ? `${check.label}: ${check.detail}` : check.label;
}

export function hintFor(code: RouteLensErrorCode | undefined): string | undefined {
  switch (code) {
    case "network":
      return 'Is your server running? Run "RouteLens: Start Server", or check the address with "RouteLens: Change Server Address".';
    case "timeout":
      return "Increase the routelens.timeoutMs setting if the endpoint is slow.";
    case "invalid-request":
      return "Check the URL and the environment selected in the status bar.";
    default:
      return undefined;
  }
}

function failedChecks(checks: readonly CheckResult[] | undefined): CheckResult[] {
  return (checks ?? []).filter((check) => !check.passed);
}

function errorLabel(code: RouteLensErrorCode | undefined): string {
  switch (code) {
    case "network":
      return "Can't connect";
    case "timeout":
      return "Timed out";
    case "invalid-request":
      return "Invalid request";
    case "invalid-file":
      return "Invalid file";
    default:
      return "Failed";
  }
}
