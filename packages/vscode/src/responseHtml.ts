import type { ApiResponse, CheckResult, FlowRun } from "@routelens/core";

// Pure HTML rendering for the response panel. No `vscode` import, so it can be unit-tested.
// The panel runs with scripts disabled; every value is escaped (see docs/02-architecture.md).

export interface ResponseView {
  requestName: string;
  method: string;
  url: string;
  environmentName: string | undefined;
  response: ApiResponse;
  /** The checks run on the response (M4); left out for plain sends before M4. */
  checks?: CheckResult[];
  /** RouteLens logged in before sending (auto-login, ADR-0008). */
  loggedIn?: boolean;
}

export interface FlowView {
  flowName: string;
  environmentName: string | undefined;
  run: FlowRun;
}

export interface ErrorView {
  requestName: string;
  method: string;
  url: string;
  message: string;
  hint: string | undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Pretty-print JSON bodies; return anything else unchanged. */
export function prettyBody(body: string, contentType: string | undefined): string {
  const looksJson = contentType?.includes("json") || /^\s*[[{]/.test(body);
  if (!looksJson) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function statusClass(status: number): "ok" | "redirect" | "error" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) return "redirect";
  return "error";
}

export function renderResponseHtml(view: ResponseView, nonce: string): string {
  const { response } = view;
  const headerRows = Object.entries(response.headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");
  const body = prettyBody(response.body, response.headers["content-type"]);
  const truncatedNote = response.truncated
    ? `<p class="note">Body cut at ${formatBytes(Buffer.byteLength(response.body))} of ${formatBytes(response.sizeBytes)}.</p>`
    : "";
  const environment = environmentPill(view.environmentName);
  const loggedIn = view.loggedIn ? `<span class="pill">logged in</span>` : "";

  return page(
    nonce,
    `
    <header>
      <h1>${escapeHtml(view.requestName)}</h1>
      <p class="request"><strong>${escapeHtml(view.method)}</strong> ${escapeHtml(response.url || view.url)}</p>
      <p class="meta">
        <span class="status ${statusClass(response.status)}">${response.status} ${escapeHtml(response.statusText)}</span>
        <span>${formatDuration(response.durationMs)}</span>
        <span>${formatBytes(response.sizeBytes)}</span>
        ${environment}
        ${loggedIn}
      </p>
    </header>
    ${checksHtml(view.checks)}
    <details>
      <summary>Headers (${Object.keys(response.headers).length})</summary>
      <table>${headerRows}</table>
    </details>
    <h2>Body</h2>
    ${truncatedNote}
    <pre>${body ? escapeHtml(body) : '<span class="muted">(empty)</span>'}</pre>
    `,
  );
}

export function renderErrorHtml(view: ErrorView, nonce: string): string {
  return page(
    nonce,
    `
    <header>
      <h1>${escapeHtml(view.requestName)}</h1>
      <p class="request"><strong>${escapeHtml(view.method)}</strong> ${escapeHtml(view.url)}</p>
      <p class="meta"><span class="status error">Request failed</span></p>
    </header>
    <p>${escapeHtml(view.message)}</p>
    ${view.hint ? `<p class="note">${escapeHtml(view.hint)}</p>` : ""}
    `,
  );
}

/** A flow run: each step with its checks, then the response of the failing (or last) step. */
export function renderFlowHtml(view: FlowView, nonce: string): string {
  const { run } = view;
  const total = run.steps.length + run.skipped.length;
  const steps = run.steps
    .map((step) => {
      const status = step.response
        ? `<span class="status ${step.passed ? "ok" : "error"}">${step.response.status} ${escapeHtml(step.response.statusText)}</span>`
        : `<span class="status error">No response</span>`;
      const error = step.error ? `<p>${escapeHtml(step.error.message)}</p>` : "";
      return `<li>
        <p class="meta"><strong>${escapeHtml(step.name)}</strong> ${status} <span>${formatDuration(step.durationMs)}</span></p>
        <p class="request"><strong>${escapeHtml(step.method)}</strong> ${escapeHtml(step.url)}</p>
        ${error}${checksHtml(step.checks, false)}
      </li>`;
    })
    .join("");
  const skipped = run.skipped
    .map((name) => `<li class="muted">${escapeHtml(name)}: not run</li>`)
    .join("");
  const shown = run.steps.at(-1);
  const body = shown?.response
    ? `<h2>Response of "${escapeHtml(shown.name)}"</h2>
    <pre>${escapeHtml(prettyBody(shown.response.body, shown.response.headers["content-type"])) || '<span class="muted">(empty)</span>'}</pre>`
    : "";

  return page(
    nonce,
    `
    <header>
      <h1>${escapeHtml(view.flowName)}</h1>
      <p class="meta">
        <span class="status ${run.passed ? "ok" : "error"}">${run.passed ? "Passed" : "Failed"}</span>
        <span>${run.steps.filter((step) => step.passed).length} of ${total} steps passed</span>
        <span>${formatDuration(run.durationMs)}</span>
        ${environmentPill(view.environmentName)}
      </p>
    </header>
    <ol class="steps">${steps}${skipped}</ol>
    ${body}
    `,
  );
}

/** The checks list. Hidden when the only check is the default one and it passed. */
function checksHtml(checks: readonly CheckResult[] | undefined, heading = true): string {
  if (!checks || checks.length === 0) return "";
  if (checks.length === 1 && checks[0]?.passed && checks[0].label === "status is below 400") {
    return "";
  }
  const items = checks
    .map(
      (check) =>
        `<li class="${check.passed ? "pass" : "fail"}">${check.passed ? "✓" : "✗"} ${escapeHtml(check.label)}${check.detail ? `<span class="muted">: ${escapeHtml(check.detail)}</span>` : ""}</li>`,
    )
    .join("");
  return `${heading ? "<h2>Checks</h2>" : ""}<ul class="checks">${items}</ul>`;
}

function environmentPill(name: string | undefined): string {
  return name
    ? `<span class="pill">env: ${escapeHtml(name)}</span>`
    : `<span class="pill muted">no environment</span>`;
}

function page(nonce: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px 24px; }
  h1 { font-size: 1.2em; margin: 16px 0 4px; }
  h2 { font-size: 1em; margin: 20px 0 8px; }
  .request { font-family: var(--vscode-editor-font-family); margin: 0 0 8px; word-break: break-all; }
  .meta { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 0; }
  .status { font-weight: 600; padding: 2px 8px; border-radius: 4px; }
  .status.ok { color: var(--vscode-testing-iconPassed); border: 1px solid var(--vscode-testing-iconPassed); }
  .status.redirect { color: var(--vscode-editorWarning-foreground); border: 1px solid var(--vscode-editorWarning-foreground); }
  .status.error { color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
  .pill { padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .muted { opacity: 0.7; }
  .note { color: var(--vscode-descriptionForeground); }
  details { margin-top: 16px; }
  summary { cursor: pointer; }
  table { border-collapse: collapse; margin-top: 8px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th { text-align: left; padding: 2px 16px 2px 0; vertical-align: top; color: var(--vscode-descriptionForeground); font-weight: normal; white-space: nowrap; }
  td { padding: 2px 0; word-break: break-all; }
  ul.checks { list-style: none; padding: 0; margin: 4px 0; font-family: var(--vscode-editor-font-family); }
  .checks .pass { color: var(--vscode-testing-iconPassed); }
  .checks .fail { color: var(--vscode-errorForeground); }
  ol.steps { padding-left: 20px; }
  ol.steps > li { margin-bottom: 12px; }
  pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>${content}</body>
</html>`;
}
