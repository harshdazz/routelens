import { RouteLensError, localServerOf, type ResolvedRequest } from "@routelens/core";

// Guard rails for requests an AI agent asks for (ADR-0009):
// - only this machine, or hosts that appear in the project's environment files (or --allow-host)
// - POST/PUT/PATCH/DELETE to a host that is not this machine need a person's OK

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface GuardOptions {
  /** Origins found in the project's environment files. */
  environmentOrigins: ReadonlySet<string>;
  /** Hosts or origins the person allowed in the server's config (`--allow-host`). */
  allowHosts: readonly string[];
  /** The person allowed writes to non-local hosts without asking (`--allow-remote-writes`). */
  allowRemoteWrites: boolean;
  /**
   * Ask the person (MCP elicitation). `true`: yes. `false`: no. `undefined`: the agent's app
   * cannot ask, which counts as no.
   */
  ask: (message: string) => Promise<boolean | undefined>;
}

/**
 * A `beforeSend` hook for one tool call. It asks at most once per host during that call, so a
 * run of ten writes to staging is one question, not ten.
 */
export function createGuard(options: GuardOptions): (request: ResolvedRequest) => Promise<void> {
  const answers = new Map<string, boolean>();
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return; // the runner reports the bad URL itself
    }
    if (localServerOf(request.url)) return;

    const allowed =
      options.environmentOrigins.has(url.origin) ||
      options.allowHosts.some(
        (host) => host === url.host || host === url.hostname || host === url.origin,
      );
    if (!allowed) {
      const known = [...options.environmentOrigins]
        .filter((origin) => !localServerOf(origin))
        .map((origin) => new URL(origin).host);
      throw new RouteLensError(
        "blocked",
        `RouteLens only sends to this machine and to hosts in the project's environment files${known.length > 0 ? ` (${known.join(", ")})` : ""}, so it did not send to ${url.host}. To allow it, add it to an environment file, or start the RouteLens MCP server with --allow-host ${url.host}.`,
      );
    }
    if (!WRITE_METHODS.has(request.method) || options.allowRemoteWrites) return;

    let answer = answers.get(url.origin);
    if (answer === undefined) {
      const reply = await options.ask(
        `An AI agent wants RouteLens to send ${request.method} ${url.href}. ${url.host} is not this machine: requests that change data there can't be undone by RouteLens. Allow POST, PUT, PATCH and DELETE requests to ${url.host} for this one task?`,
      );
      if (reply === undefined) {
        throw new RouteLensError(
          "blocked",
          `${request.method} to ${url.host} (not this machine) needs a person's OK, and this AI app cannot ask for it. Ask the person to run it themselves, or to start the RouteLens MCP server with --allow-remote-writes.`,
        );
      }
      answer = reply;
      answers.set(url.origin, answer);
    }
    if (!answer) {
      throw new RouteLensError(
        "blocked",
        `The person said no to ${request.method} requests to ${url.host}.`,
      );
    }
  };
}
