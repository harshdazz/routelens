import type { ApiRequest } from "../model.js";
import { resolveRequest, type ResolvedRequest } from "../resolve.js";
import { sendRequest, type ApiResponse, type SendOptions } from "../send.js";
import type { Variables } from "../variables.js";

// Auto-login (ADR-0008): find the login request, log in when a route answers 401, and reuse
// the token for every request to the same server. Credentials come from the person (VS Code
// SecretStorage, or environment variables in CI), never from files.

/** A request that logs in, and which of its body fields take the username and password. */
export interface LoginRequest {
  /** The request file, when it is a saved request. */
  file: string | undefined;
  request: ApiRequest;
  usernameField: string | undefined;
  passwordField: string;
}

export interface Credentials {
  username?: string;
  password: string;
}

/** What RouteLens sends after logging in: `Authorization: Bearer …` or `Cookie: …`. */
export type AuthToken = { kind: "bearer"; value: string } | { kind: "cookie"; value: string };

export type LoginOutcome =
  | { ok: true; response: ApiResponse; token: AuthToken }
  | { ok: false; reason: string; response?: ApiResponse };

/** Last path segment → how sure we are that a POST there logs in. */
const LOGIN_SEGMENTS: Readonly<Record<string, number>> = {
  login: 3,
  "log-in": 3,
  signin: 3,
  "sign-in": 3,
  sign_in: 3,
  authenticate: 2,
  session: 2,
  sessions: 2,
  token: 2,
  auth: 1,
};
const PASSWORD_FIELD = /^(password|passwd|pass|pwd)$|password/i;
const USERNAME_FIELD = /^(email|username|user|login|identifier|phone)$|email|username|user_?name/i;
/** Response fields that hold a token, compared in lower case without `_` and `-`. */
const TOKEN_FIELDS = new Set([
  "token",
  "accesstoken",
  "jwt",
  "idtoken",
  "authtoken",
  "sessiontoken",
]);

/**
 * The request that logs in, among the saved requests: a POST to `/login`, `/signin`,
 * `/auth/login`, `/session`, `/token`… whose body has a password field. The best match wins.
 */
export function findLoginRequest(
  requests: ReadonlyArray<{ file?: string; request: ApiRequest }>,
): LoginRequest | undefined {
  let best: { login: LoginRequest; score: number; depth: number } | undefined;
  for (const { file, request } of requests) {
    if (request.method !== "POST") continue;
    const segments = pathOf(request)
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    const last = segments.at(-1);
    const score = last === undefined ? undefined : LOGIN_SEGMENTS[last];
    if (score === undefined || segments.some((segment) => segment.includes("nextauth"))) continue;

    const fields = bodyFields(request);
    const passwordField = fields.find((field) => PASSWORD_FIELD.test(field));
    if (!passwordField) continue;
    const usernameField = fields.find((field) => USERNAME_FIELD.test(field));
    const depth = segments.length;
    if (!best || score > best.score || (score === best.score && depth < best.depth)) {
      best = { login: { file, request, usernameField, passwordField }, score, depth };
    }
  }
  return best?.login;
}

/**
 * The token in a login response: a token-like field in the JSON body (the closest to the
 * top wins, up to 3 levels deep), else the cookies the server set.
 */
export function findToken(response: ApiResponse): AuthToken | undefined {
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = undefined;
  }
  let level: unknown[] = [body];
  for (let depth = 0; depth < 3 && level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const value of level) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      for (const [key, item] of Object.entries(value)) {
        if (
          TOKEN_FIELDS.has(key.toLowerCase().replace(/[_-]/g, "")) &&
          typeof item === "string" &&
          item
        ) {
          return { kind: "bearer", value: item };
        }
        next.push(item);
      }
    }
    level = next;
  }
  const cookies = response.setCookies
    .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("="));
  return cookies.length > 0 ? { kind: "cookie", value: cookies.join("; ") } : undefined;
}

/**
 * Logs in once and adds the token to requests for the same server. One session per
 * project and environment; the extension keeps it for the VS Code session, the CLI for a run.
 */
export class AuthSession {
  private token: AuthToken | undefined;
  private origin: string | undefined;
  private pending: Promise<LoginOutcome> | undefined;
  /** Why the last login failed. RouteLens stops trying until `clearFailure()`. */
  failure: string | undefined;

  constructor(
    readonly login: LoginRequest,
    /** `ask` is false when RouteLens only wants credentials the person already gave. */
    private readonly credentials: (ask: boolean) => Promise<Credentials | undefined>,
  ) {}

  get loggedIn(): boolean {
    return this.token !== undefined;
  }

  /** The login request itself is never given a token or retried. */
  isLoginRequest(request: ApiRequest, file?: string): boolean {
    if (file !== undefined && this.login.file !== undefined) return file === this.login.file;
    return request.method === this.login.request.method && request.url === this.login.request.url;
  }

  /** The request with the token added, when it goes to the server RouteLens logged in to. */
  apply(request: ResolvedRequest): ResolvedRequest {
    if (!this.token || !this.origin || originOf(request.url) !== this.origin) return request;
    const header = this.token.kind === "bearer" ? "Authorization" : "Cookie";
    if (Object.keys(request.headers).some((name) => name.toLowerCase() === header.toLowerCase())) {
      return request;
    }
    const value = this.token.kind === "bearer" ? `Bearer ${this.token.value}` : this.token.value;
    return { ...request, headers: { ...request.headers, [header]: value } };
  }

  /** True when `url` goes to the server this session logs in to. */
  covers(url: string, variables: Variables): boolean {
    const loginUrl = resolveRequest(this.login.request, variables).request.url;
    return originOf(url) === originOf(loginUrl);
  }

  /** Log in now. Calls made while a login is running wait for it instead of logging in twice. */
  logIn(variables: Variables, options: SendOptions = {}, ask = true): Promise<LoginOutcome> {
    this.pending ??= this.send(variables, options, ask).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  clearFailure(): void {
    this.failure = undefined;
  }

  /** Forget the token (Log Out, or the credentials changed). */
  logOut(): void {
    this.token = undefined;
    this.origin = undefined;
    this.failure = undefined;
  }

  private async send(
    variables: Variables,
    options: SendOptions,
    ask: boolean,
  ): Promise<LoginOutcome> {
    const credentials = await this.credentials(ask);
    if (!credentials) {
      const reason = "No login details were given.";
      // Only a refused question stops later tries; not asking is not a failure.
      return ask ? this.fail(reason) : { ok: false, reason };
    }
    const { request } = resolveRequest(withCredentials(this.login, credentials), variables);
    const response = await sendRequest(request, options);
    const label = `${request.method} ${new URL(request.url).pathname}`;
    if (response.status >= 400) {
      return this.fail(`Login failed: ${label} answered ${response.status}.`, response);
    }
    const token = findToken(response);
    if (!token) {
      return this.fail(
        `${label} answered ${response.status}, but RouteLens found no token or cookie in the response.`,
        response,
      );
    }
    this.token = token;
    this.origin = originOf(request.url);
    this.failure = undefined;
    return { ok: true, response, token };
  }

  private fail(reason: string, response?: ApiResponse): LoginOutcome {
    this.failure = reason;
    return response ? { ok: false, reason, response } : { ok: false, reason };
  }
}

/** The login request with the person's username and password in its body. */
export function withCredentials(login: LoginRequest, credentials: Credentials): ApiRequest {
  const fields: Record<string, string> = { [login.passwordField]: credentials.password };
  if (login.usernameField && credentials.username !== undefined) {
    fields[login.usernameField] = credentials.username;
  }
  const { body } = login.request;
  if (body.type === "form") {
    return { ...login.request, body: { type: "form", content: { ...body.content, ...fields } } };
  }
  const content = body.type === "json" && isObject(body.content) ? body.content : {};
  return { ...login.request, body: { type: "json", content: { ...content, ...fields } } };
}

function pathOf(request: ApiRequest): string {
  const fromRoute = request.route?.key.split(" ")[1];
  if (fromRoute) return fromRoute;
  const withoutBase = request.url.replace(/^\{\{[^}]+\}\}/, "");
  try {
    return new URL(withoutBase).pathname;
  } catch {
    return withoutBase.split("?")[0] ?? "";
  }
}

function bodyFields(request: ApiRequest): string[] {
  const { body } = request;
  if (body.type === "form") return Object.keys(body.content);
  if (body.type === "json" && isObject(body.content)) return Object.keys(body.content);
  return [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
