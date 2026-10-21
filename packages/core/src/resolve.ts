import { RouteLensError } from "./errors.js";
import { METHODS_WITHOUT_BODY, type ApiRequest, type HttpMethod } from "./model.js";
import { interpolate, type Variables } from "./variables.js";

/** A request with variables replaced and the body serialized, ready to send. */
export interface ResolvedRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ResolveResult {
  request: ResolvedRequest;
  /** Variables used by the request but missing from the environment. */
  missingVariables: string[];
}

const DEFAULT_CONTENT_TYPES = {
  json: "application/json",
  text: "text/plain; charset=utf-8",
  form: "application/x-www-form-urlencoded",
} as const;

/** Replace `{{variables}}`, append the query string and serialize the body. */
export function resolveRequest(request: ApiRequest, variables: Variables): ResolveResult {
  const missing = new Set<string>();
  const fill = (template: string): string => {
    const result = interpolate(template, variables);
    result.missing.forEach((name) => missing.add(name));
    return result.value;
  };
  const fillPair = ([key, value]: [string, string]): [string, string] => [fill(key), fill(value)];

  let url = fill(request.url);
  const query = Object.entries(request.query).map(fillPair);
  if (query.length > 0) {
    url += (url.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[fill(name)] = fill(value);
  }

  const { body } = request;
  if (body.type !== "none" && METHODS_WITHOUT_BODY.includes(request.method)) {
    throw new RouteLensError(
      "invalid-request",
      `${request.method} requests cannot have a body. Set "body" to { "type": "none" }.`,
    );
  }

  let serializedBody: string | undefined;
  switch (body.type) {
    case "none":
      break;
    case "json":
      if (body.content === undefined) {
        throw new RouteLensError("invalid-request", 'The JSON body is missing its "content".');
      }
      serializedBody = JSON.stringify(fillJson(body.content, fill));
      break;
    case "text":
      serializedBody = fill(body.content);
      break;
    case "form":
      serializedBody = new URLSearchParams(Object.entries(body.content).map(fillPair)).toString();
      break;
  }

  if (body.type !== "none" && !hasHeader(headers, "content-type")) {
    headers["Content-Type"] = DEFAULT_CONTENT_TYPES[body.type];
  }

  return {
    request: {
      method: request.method,
      url,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    },
    missingVariables: [...missing],
  };
}

/** Replace variables inside every string (keys and values) of a JSON value. */
function fillJson(value: unknown, fill: (template: string) => string): unknown {
  if (typeof value === "string") {
    return fill(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => fillJson(item, fill));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [fill(key), fillJson(item, fill)]),
    );
  }
  return value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}
