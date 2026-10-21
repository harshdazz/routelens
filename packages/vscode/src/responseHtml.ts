import type { ApiResponse } from "@routelens/core";

// Pure HTML rendering for the response panel. No `vscode` import, so it can be unit-tested.
// The panel runs with scripts disabled; every value is escaped (see docs/02-architecture.md).

export interface ResponseView {
  requestName: string;
  method: string;
  url: string;
  environmentName: string | undefined;
  response: ApiResponse;
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
  const environment = view.environmentName
    ? `<span class="pill">env: ${escapeHtml(view.environmentName)}</span>`
    : `<span class="pill muted">no environment</span>`;

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
      </p>
    </header>
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
  pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>${content}</body>
</html>`;
}
