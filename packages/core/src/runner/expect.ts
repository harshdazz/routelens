import { STATUS_CODES } from "node:http";
import { isDeepStrictEqual } from "node:util";
import type { Expectation, Matcher } from "../model.js";
import type { ApiResponse } from "../send.js";
import { readValuePath } from "./valuePath.js";

/** One check on a response: `status is 201` ✓, or `body.id is a number` ✗ `got "abc"`. */
export interface CheckResult {
  label: string;
  passed: boolean;
  /** Why it failed, e.g. `got 404 Not Found`. */
  detail?: string;
}

/** What paths read: the response with its body parsed as JSON when it is JSON. */
export function responseSubject(response: ApiResponse): Record<string, unknown> {
  return {
    status: response.status,
    statusText: response.statusText,
    durationMs: response.durationMs,
    headers: response.headers,
    body: parseBody(response.body),
  };
}

/**
 * Check a response against an expectation (ADR-0008). Without one, the response passes when
 * its status is below 400. `expectation` must already have its `{{variables}}` filled in.
 */
export function checkResponse(
  response: ApiResponse,
  expectation: Expectation | undefined,
): CheckResult[] {
  const statusText =
    `${response.status} ${response.statusText || STATUS_CODES[response.status] || ""}`.trim();
  if (!expectation) {
    return [result("status is below 400", response.status < 400, `got ${statusText}`)];
  }

  const checks: CheckResult[] = [];
  const { status } = expectation;
  if (status !== undefined) {
    const codes = Array.isArray(status) ? status : [status];
    const passed = codes.some((code) =>
      typeof code === "number" ? code === response.status : code[0] === String(response.status)[0],
    );
    checks.push(result(`status is ${codes.join(" or ")}`, passed, `got ${statusText}`));
  }

  const subject = responseSubject(response);
  if (expectation.body !== undefined) {
    const mismatch = partialMismatch(subject.body, expectation.body, "body");
    checks.push(result(`body contains ${short(expectation.body)}`, !mismatch, mismatch));
  }

  for (const [path, expected] of Object.entries(expectation.values ?? {})) {
    const matcher: Matcher = isMatcher(expected) ? expected : { equals: expected };
    const { found, value } = readValuePath(subject, path);
    checks.push(checkValue(path, matcher, found, value));
  }

  if (expectation.maxDurationMs !== undefined) {
    const took = Math.round(response.durationMs);
    checks.push(
      result(
        `took at most ${expectation.maxDurationMs} ms`,
        response.durationMs <= expectation.maxDurationMs,
        `took ${took} ms`,
      ),
    );
  }

  // An expectation with nothing in it still says something: the status must be fine.
  return checks.length > 0 ? checks : checkResponse(response, undefined);
}

/** True when the expectation says the server must answer 401 (no auto-login then). */
export function expects401(expectation: Expectation | undefined): boolean {
  const status = expectation?.status;
  if (status === undefined) return false;
  return (Array.isArray(status) ? status : [status]).some((code) => code === 401 || code === "4xx");
}

function checkValue(path: string, matcher: Matcher, found: boolean, value: unknown): CheckResult {
  const got = found ? `got ${short(value)}` : `${path} is missing`;
  if (matcher.exists !== undefined) {
    return result(
      matcher.exists ? `${path} exists` : `${path} is missing`,
      found === matcher.exists,
      found ? `${path} is ${short(value)}` : `${path} is missing`,
    );
  }
  if (matcher.type !== undefined) {
    return result(
      `${path} is ${article(matcher.type)}`,
      found && typeOf(value) === matcher.type,
      found ? `got ${typeOf(value)} ${short(value)}` : got,
    );
  }
  if (matcher.contains !== undefined) {
    return result(
      `${path} contains ${short(matcher.contains)}`,
      found && contains(value, matcher.contains),
      got,
    );
  }
  if (matcher.matches !== undefined) {
    const text = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
    return result(
      `${path} matches /${matcher.matches}/`,
      text !== undefined && new RegExp(matcher.matches).test(text),
      got,
    );
  }
  if (matcher.lessThan !== undefined) {
    return result(
      `${path} is less than ${matcher.lessThan}`,
      typeof value === "number" && value < matcher.lessThan,
      got,
    );
  }
  if (matcher.greaterThan !== undefined) {
    return result(
      `${path} is greater than ${matcher.greaterThan}`,
      typeof value === "number" && value > matcher.greaterThan,
      got,
    );
  }
  return result(
    `${path} is ${short(matcher.equals)}`,
    found && isDeepStrictEqual(value, matcher.equals),
    got,
  );
}

/** `undefined` when `actual` contains `expected`; otherwise the first difference. */
function partialMismatch(actual: unknown, expected: unknown, path: string): string | undefined {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return path === "body" && typeof actual === "string"
        ? "the body is not JSON"
        : `${path} is ${short(actual)}, not an object`;
    }
    for (const [key, value] of Object.entries(expected)) {
      const childPath = `${path}.${key}`;
      if (!Object.hasOwn(actual, key)) return `${childPath} is missing`;
      const mismatch = partialMismatch(actual[key], value, childPath);
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  return isDeepStrictEqual(actual, expected)
    ? undefined
    : `${path} is ${short(actual)}, expected ${short(expected)}`;
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected);
  if (Array.isArray(actual)) {
    return actual.some(
      (item) =>
        isDeepStrictEqual(item, expected) ||
        (isPlainObject(expected) && partialMismatch(item, expected, "item") === undefined),
    );
  }
  return isPlainObject(actual) && partialMismatch(actual, expected, "value") === undefined;
}

function isMatcher(value: unknown): value is Matcher {
  return isPlainObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function article(type: string): string {
  return type === "null" ? "null" : `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
}

function parseBody(body: string): unknown {
  if (body.trim() === "") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/** A value for a label: JSON, cut at 60 characters. */
function short(value: unknown): string {
  const text = value === undefined ? "nothing" : (JSON.stringify(value) ?? String(value));
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function result(label: string, passed: boolean, detail?: string): CheckResult {
  return passed ? { label, passed } : { label, passed, ...(detail ? { detail } : {}) };
}
