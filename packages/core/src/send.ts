import { RouteLensError } from "./errors.js";
import type { ResolvedRequest } from "./resolve.js";

export interface ApiResponse {
  status: number;
  statusText: string;
  /** Final URL after redirects. */
  url: string;
  /** Header names are lower-case. */
  headers: Record<string, string>;
  /** Each `Set-Cookie` header on its own (`headers` joins them, which breaks dates). */
  setCookies: string[];
  /** Body decoded as UTF-8 (cut at `maxBodyBytes`). */
  body: string;
  /** Full body size in bytes, even when `body` was truncated. */
  sizeBytes: number;
  truncated: boolean;
  /** Time from sending until the whole body was received. */
  durationMs: number;
}

export interface SendOptions {
  /** Default 30 seconds. */
  timeoutMs?: number;
  /** Abort to cancel the request (e.g. a "Cancel" button). */
  signal?: AbortSignal;
  /** Bodies larger than this are cut in `body`. Default 5 MB. */
  maxBodyBytes?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Send a resolved request and read the whole response. */
export async function sendRequest(
  request: ResolvedRequest,
  options: SendOptions = {},
): Promise<ApiResponse> {
  const url = parseHttpUrl(request.url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fetchImpl = options.fetch ?? fetch;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  const startedAt = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "follow",
      signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const durationMs = performance.now() - startedAt;
    const truncated = bytes.byteLength > maxBodyBytes;

    return {
      status: response.status,
      statusText: response.statusText,
      url: response.url || url.toString(),
      headers: Object.fromEntries(response.headers),
      setCookies: response.headers.getSetCookie(),
      body: new TextDecoder().decode(truncated ? bytes.subarray(0, maxBodyBytes) : bytes),
      sizeBytes: bytes.byteLength,
      truncated,
      durationMs,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw new RouteLensError("aborted", "The request was cancelled.", { cause: error });
    }
    if (timeoutSignal.aborted) {
      throw new RouteLensError("timeout", `No response after ${timeoutMs} ms.`, { cause: error });
    }
    throw new RouteLensError(
      "network",
      `Could not reach ${url.host}: ${describeNetworkError(error)}`,
      {
        cause: error,
      },
    );
  }
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new RouteLensError(
      "invalid-request",
      `"${raw}" is not a valid URL. Check for missing {{variables}} or a missing http://.`,
      { cause: error },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RouteLensError(
      "invalid-request",
      `Only http and https URLs are supported, got "${url.protocol}".`,
    );
  }
  return url;
}

/** Node's fetch hides the real reason (ECONNREFUSED, ENOTFOUND, ...) in `cause`. */
function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error) {
      const code = (cause as NodeJS.ErrnoException).code;
      return code ? `${code} (${cause.message})` : cause.message;
    }
    return error.message;
  }
  return String(error);
}
