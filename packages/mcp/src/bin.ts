import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { version as VERSION } from "../package.json";
import { createServer } from "./server.js";

// The `routelens-mcp` command: an MCP server on stdin/stdout (ADR-0009). Agents start it
// themselves; stdout belongs to the protocol, so messages for people go to stderr.

const USAGE = `Usage: routelens-mcp [options]

An MCP server that lets AI agents (Claude Code, Cursor, Copilot) list this project's API
routes, run them and read failures. Agents start it; you add it to their MCP config.

Options:
  --root <folder>          The project (default: the current folder)
  --env <name>             Default environment (default: local)
  --allow-host <host>      Also send to this host. Repeat for more. By default only this
                           machine and the hosts in .routelens/environments are allowed.
  --allow-remote-writes    POST, PUT, PATCH and DELETE to hosts that are not this machine
                           without asking. By default the agent's app must ask the person.
  --timeout <ms>           Timeout of each request (default 30000)
  -h, --help               Show this help
  -v, --version            Show the version

Login: set ROUTELENS_USERNAME and ROUTELENS_PASSWORD in the server's environment to log in
automatically when a route answers 401.
`;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        root: { type: "string" },
        env: { type: "string" },
        "allow-host": { type: "string", multiple: true },
        "allow-remote-writes": { type: "boolean" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stderr.write(`${VERSION}\n`);
    return 0;
  }
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutMs !== undefined && !(timeoutMs > 0)) {
    process.stderr.write("--timeout takes a positive number of milliseconds.\n");
    return 2;
  }

  const password = process.env.ROUTELENS_PASSWORD;
  const username = process.env.ROUTELENS_USERNAME;
  const server = createServer({
    root: values.root ?? process.cwd(),
    ...(values.env === undefined ? {} : { environment: values.env }),
    allowHosts: values["allow-host"] ?? [],
    allowRemoteWrites: values["allow-remote-writes"] ?? false,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(password === undefined
      ? {}
      : { credentials: username === undefined ? { password } : { username, password } }),
    version: VERSION,
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `RouteLens MCP server ${VERSION} ready (${values.root ?? process.cwd()}).\n`,
  );
  return -1; // keep running until the agent closes stdin
}

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
