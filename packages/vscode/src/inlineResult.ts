import { STATUS_CODES } from "node:http";
import type { RouteLensErrorCode } from "@routelens/core";
import { formatDuration, prettyBody, type ErrorView, type ResponseView } from "./responseHtml";

// Text for the inline result shown next to "▶ Send request". No `vscode` import, so it can be
// unit-tested.

/** The last thing that happened to a request file. */
export type LastResult =
  | { kind: "sending" }
  | { kind: "response"; view: ResponseView }
  | { kind: "error"; view: ErrorView; code: RouteLensErrorCode | undefined };

const PREVIEW_CHARS = 600;

/** `✓ 201 Created · 14 ms`, `✗ 404 Not Found · 3 ms`, `✗ Can't connect` */
export function inlineResultTitle(result: LastResult): string {
  switch (result.kind) {
    case "sending":
      return "$(sync~spin) Sending...";
    case "response": {
      const { status, statusText, durationMs } = result.view.response;
      const icon = status < 400 ? "✓" : "✗";
      const text = statusText || STATUS_CODES[status] || "";
      return `${icon} ${status}${text ? ` ${text}` : ""} · ${formatDuration(durationMs)}`;
    }
    case "error":
      return `✗ ${errorLabel(result.code)}`;
  }
}

/** Hover text: the start of the body (pretty JSON), or the error message. */
export function inlineResultTooltip(result: LastResult): string {
  switch (result.kind) {
    case "sending":
      return "Sending the request...";
    case "response": {
      const { response } = result.view;
      const body = prettyBody(response.body, response.headers["content-type"]);
      const preview =
        body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}\n...` : body || "(empty)";
      return `${preview}\n\nClick to open the full response.`;
    }
    case "error":
      return `${result.view.message}${result.view.hint ? `\n\n${result.view.hint}` : ""}`;
  }
}

function errorLabel(code: RouteLensErrorCode | undefined): string {
  switch (code) {
    case "network":
      return "Can't connect";
    case "timeout":
      return "Timed out";
    case "invalid-request":
      return "Invalid request";
    default:
      return "Failed";
  }
}
