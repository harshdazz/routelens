export type RouteLensErrorCode =
  /** A file on disk is not valid JSON or does not match its schema. */
  | "invalid-file"
  /** The request cannot be sent as written (bad URL, body on GET, ...). */
  | "invalid-request"
  /** The server did not answer within the timeout. */
  | "timeout"
  /** The user cancelled the request. */
  | "aborted"
  /** DNS failure, connection refused, TLS error, ... */
  | "network";

/** Every error RouteLens raises on purpose. `message` is safe to show to the user. */
export class RouteLensError extends Error {
  readonly code: RouteLensErrorCode;
  /** Extra lines for logs, e.g. one line per schema problem. */
  readonly details: readonly string[];

  constructor(
    code: RouteLensErrorCode,
    message: string,
    options: { cause?: unknown; details?: readonly string[] } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RouteLensError";
    this.code = code;
    this.details = options.details ?? [];
  }
}
