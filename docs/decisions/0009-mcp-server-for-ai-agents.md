# ADR-0009: MCP server for AI agents

- Status: Accepted
- Date: 2026-10-21

## Context

M5 lets the AI agent a developer already uses work with RouteLens ([ADR-0005](0005-ai-uses-what-the-user-has.md)). The agents are Claude Code, Cursor, and Copilot agent mode in VS Code. The goal is "test my API and fix what's broken": the agent lists the routes, runs them, reads what failed and the code behind it, and proposes a fix. The Model Context Protocol (MCP) is how all three agents call outside tools. Several things had to be decided:

1. How the server runs.
2. Which tools it offers.
3. How it stays safe when an AI decides what to send.
4. How each agent gets set up with no or little work.

## Decision

**A stdio MCP server in a new package, `@routelens/mcp`** (command `routelens-mcp`), built on the official `@modelcontextprotocol/sdk`.

- The agent starts it as a child process and talks over stdin/stdout.
- The project is `--root` (default: the folder it starts in).
- Every tool calls core: `scanRoutes`, `runRequest`, `runFlow` ([ADR-0008](0008-autopilot-runner-flows-login.md)). So an agent, the VS Code board and `routelens run` agree on what passed.
- It works without `.routelens/` too. The address then comes from `detectServer` (zero setup, read only), and routes without a request file are run from an in-memory draft. Nothing is written for that.

**Tools:**

| Tool                | What it does                                                                                                               | Writes?    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `list_routes`       | Routes found in the code (with file:line and sample body), saved requests, flows, the environment and its address          | no         |
| `read_route_source` | The handler's code with line numbers, and the zod schema it validates with                                                 | no         |
| `send_request`      | Send a saved request, a route's request, or a request written by the agent, with optional `expect` checks                  | sends HTTP |
| `run_all`           | Run every saved request, every route without one, and every flow; a pass/fail list                                         | sends HTTP |
| `run_flow`          | Run a saved flow, or a flow the agent wrote, without saving it                                                             | sends HTTP |
| `save_flow`         | Validate a flow and save it to `.routelens/flows/` (refuses to overwrite unless asked)                                     | one file   |
| `get_last_failure`  | The last failed request: what was sent, what came back, which checks failed, the route it belongs to and that route's code | no         |

Tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) let the agent's app decide what to confirm. Results are JSON text: every agent reads it well. Code is plain text with line numbers, so the agent can point at a line.

**Guard rails** (the risk "an AI agent sends harmful requests" in the product spec):

- **Hosts:** requests go only to this machine (`localhost`, `127.0.0.1`, `::1`, `*.localhost`) or to a host that appears in one of the project's environment files. Other hosts are refused. A person can add hosts with `--allow-host` in the agent's config.
- **Writes elsewhere need a person:** a `POST`/`PUT`/`PATCH`/`DELETE` to a host that is not this machine needs a yes. RouteLens asks through MCP elicitation, so the agent's app shows the question to the person, not to the AI. It asks once per host for each tool call. If the app can't ask (no elicitation support), the request is refused, unless a person started the server with `--allow-remote-writes`.
- **How it is enforced:** a new `beforeSend` hook in core's runner checks every request just before it is sent, including steps of flows whose URLs come from extracted values. A refused request ends as error code `blocked`, with the reason.
- **Files:** `read_route_source` only reads route files that the scanner found inside the root. `save_flow` only writes `.routelens/flows/<slug>.flow.json`.
- **No server starts:** MCP tools never start the dev server. Starting it runs project code, and the agent can ask the person to do that through its own, already confirmed, terminal.
- **No passwords through the agent:** auto-login uses `ROUTELENS_USERNAME` / `ROUTELENS_PASSWORD` from the server's environment (set by the person in the agent's config). They are never a tool input or output.

**Setup:**

- **Copilot agent mode (VS Code):** the extension registers the server with `vscode.lm.registerMcpServerDefinitionProvider`, one server per trusted workspace folder. There is nothing to set up. It runs VS Code's own Node (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`) on `dist/mcp-server.js` inside the extension. This API is stable from VS Code 1.101. RouteLens keeps `engines.vscode` at `^1.95.0`, types the few calls it needs itself, and registers only when the editor has the API. That way the extension still installs in editors built on older VS Code (some forks), which simply skip this part.
- **Claude Code and Cursor:** the command "RouteLens: Connect an AI Agent" sets them up.
  - First it copies the bundled server to the extension's global storage. That path does not change when the extension updates.
  - Claude Code: it runs `claude mcp add --scope local routelens …` in a visible terminal. If `claude` is not installed, it copies the command instead.
  - Cursor: it opens Cursor's MCP install link, and Cursor asks the person to confirm.
  - Other agents: "copy the config" gives the standard `mcpServers` JSON.
- **Once published (M6):** `npx -y @routelens/mcp` will work everywhere with no path at all. A project can then commit it in `.mcp.json`.

## Why

- **Stdio:** it is the transport every agent supports. A local HTTP server inside VS Code would share the editor's state, but other programs and web pages on the same machine could reach it, and Claude Code or Cursor would only work while VS Code is open.
- **One runner:** pass/fail stays the same everywhere. The agent sees exactly what the board shows.
- **Asking through elicitation:** when an app auto-approves tool calls, the AI could otherwise confirm its own writes. Elicitation questions go to the person.
- **Small tool set:** seven tools, each with a clear job, are easier for a model to use correctly than a big API mirror. `get_last_failure` + `read_route_source` exist to make "find the bug" a two-step task.

## Consequences

- The extension ships TypeScript twice (in `extension.js` and `mcp-server.js`, about 3.5 MB each, minified). Sharing one copy is a follow-up for the v0.1 package size (M6).
- The automatic login after a 401 goes to the server the agent was already allowed to call. It is not asked about as a write.
- Core gets `beforeSend`, the `blocked` error code, `matchRoute` (which route a URL belongs to) and `writeFlowFile`.
- Results of agent runs live in the MCP server process. They don't appear inline in the editor. Sharing them with the extension is a possible later step.
- Agents without elicitation can't write to non-local hosts unless the person allows it in the config. That is safe by default.
