import * as vscode from "vscode";
import {
  AuthSession,
  findLoginRequest,
  listRequestFiles,
  readRequestFile,
  type Credentials,
  type LoginRequest,
} from "@routelens/core";

/** workspaceState: the SecretStorage keys RouteLens wrote, so Log Out can delete them all. */
const STORED_KEYS = "routelens.loginKeys";

/**
 * Auto-login in VS Code (ADR-0008). One session per project and environment. The username
 * and password are asked the first time a route answers 401 and kept in SecretStorage (the
 * OS keychain); the token lives in memory only. Nothing is written to `.routelens/`.
 */
export class Logins implements vscode.Disposable {
  private readonly sessions = new Map<string, { signature: string; session: AuthSession }>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** The project's login session, or `undefined` when it has no login request. */
  async session(root: string, environment: string): Promise<AuthSession | undefined> {
    const key = sessionKey(root, environment);
    const login = await findProjectLogin(root);
    if (!login) {
      this.sessions.delete(key);
      return undefined;
    }
    // A changed login request starts a new session (and drops the old token).
    const signature = JSON.stringify([login.file, login.request.url, login.request.body]);
    const existing = this.sessions.get(key);
    if (existing?.signature === signature) return existing.session;
    const session = new AuthSession(login, (ask) =>
      this.credentials(root, environment, login, ask),
    );
    this.sessions.set(key, { signature, session });
    return session;
  }

  /** Forget the stored username and password of one project (e.g. a wrong password). */
  async forget(root: string, environment: string): Promise<void> {
    await this.context.secrets.delete(sessionKey(root, environment));
    const entry = this.sessions.get(sessionKey(root, environment));
    entry?.session.logOut();
  }

  /** Log Out: forget every token and every stored login. Returns how many were forgotten. */
  async logOut(): Promise<number> {
    const keys = this.context.workspaceState.get<string[]>(STORED_KEYS, []);
    for (const key of keys) await this.context.secrets.delete(key);
    await this.context.workspaceState.update(STORED_KEYS, []);
    for (const { session } of this.sessions.values()) session.logOut();
    const count = Math.max(keys.length, this.sessions.size);
    this.sessions.clear();
    return count;
  }

  dispose(): void {
    this.sessions.clear();
  }

  private async credentials(
    root: string,
    environment: string,
    login: LoginRequest,
    ask: boolean,
  ): Promise<Credentials | undefined> {
    const key = sessionKey(root, environment);
    const stored = parseCredentials(await this.context.secrets.get(key));
    if (stored || !ask) return stored;

    const where = `${login.request.method} ${login.request.route?.key.split(" ")[1] ?? login.request.url}`;
    const title = `RouteLens: log in (${where})`;
    const prompt =
      "A route answered 401 Unauthorized. RouteLens logs in once and reuses the token. Your login is kept in your system keychain, never in files.";
    let username: string | undefined;
    if (login.usernameField) {
      username = await vscode.window.showInputBox({
        title,
        prompt,
        placeHolder: login.usernameField,
        ignoreFocusOut: true,
      });
      if (username === undefined) return undefined;
    }
    const password = await vscode.window.showInputBox({
      title,
      prompt: login.usernameField ? undefined : prompt,
      placeHolder: login.passwordField,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return undefined;

    const credentials: Credentials = username === undefined ? { password } : { username, password };
    await this.context.secrets.store(key, JSON.stringify(credentials));
    const keys = this.context.workspaceState.get<string[]>(STORED_KEYS, []);
    if (!keys.includes(key)) await this.context.workspaceState.update(STORED_KEYS, [...keys, key]);
    return credentials;
  }
}

/** The login request among the project's saved requests (files that don't parse are skipped). */
async function findProjectLogin(root: string): Promise<LoginRequest | undefined> {
  const requests = [];
  for (const file of await listRequestFiles(root)) {
    try {
      requests.push({ file, request: await readRequestFile(file) });
    } catch {
      // A broken file is reported when it is sent, not here.
    }
  }
  return findLoginRequest(requests);
}

function sessionKey(root: string, environment: string): string {
  return `routelens.login:${root}:${environment}`;
}

/** Stored credentials, checked: SecretStorage holds text that could be anything. */
function parseCredentials(text: string | undefined): Credentials | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as { username?: unknown; password?: unknown };
    if (typeof value.password !== "string") return undefined;
    return typeof value.username === "string"
      ? { username: value.username, password: value.password }
      : { password: value.password };
  } catch {
    return undefined;
  }
}
