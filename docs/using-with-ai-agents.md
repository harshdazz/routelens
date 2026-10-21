# Using RouteLens with AI agents

RouteLens has an MCP server, a set of tools an AI agent can call. With it, Copilot agent mode, Claude Code, Cursor or any MCP agent can test your API the way you would with RouteLens: list the routes, run them, see what failed and read the code behind it. Then the agent proposes the fix.

The agent does the thinking. RouteLens runs requests with plain code and tells the truth about what came back ([ADR-0009](decisions/0009-mcp-server-for-ai-agents.md)).

## Try it

Start your dev server, then ask your agent:

> Test my API and fix what's broken.

A typical run:

1. `list_routes`: the routes in your code, where each handler is, sample bodies from your zod schemas.
2. `run_all`: every route, request and flow. For example, "5 passed, 1 failed: `GET /api/todos/:id` (`src/routes/todos.js:23`)".
3. `get_last_failure`: what was sent, the 404 that came back, and the handler's code with line numbers.
4. The agent spots the bug, edits the code, and runs `send_request` or `run_all` again to confirm.

To see it on a known bug, copy `fixtures/buggy-api` from this repo somewhere, run `npm ci` and `npm run dev` there, and point your agent at that folder.

## Tools

| Tool                | What the agent gets                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `list_routes`       | Routes (method, path, handler file:line, sample body), saved requests, flows, and the server address with where it came from |
| `read_route_source` | A handler's code with line numbers and an arrow on its line, and the zod schema it validates the body with                   |
| `send_request`      | One request (a saved one, a route's, or its own), with optional `expect` checks; the status, headers, body and checks        |
| `run_all`           | Everything, like the Test Everything button: passed or failed for each, with the route                                       |
| `run_flow`          | A saved flow, or one the agent wrote, step by step, without saving it                                                        |
| `save_flow`         | Saves a flow to `.routelens/flows/` for you to review; RouteLens, the CLI and CI then replay it with plain code              |
| `get_last_failure`  | The last failure in detail: what was sent, what came back, which check failed, and the route's code                          |

It works without any setup in the project. With no `.routelens/` folder, RouteLens finds the server address the same way zero setup does, and runs each route with a sample request made in memory.

## Set it up

### Copilot agent mode (VS Code)

Nothing to do with VS Code 1.101 or newer and the RouteLens extension installed. Open Chat, pick **Agent**, and RouteLens shows up in the tools list (one server per workspace folder). It only runs in workspaces you trust.

### Claude Code

Run **RouteLens: Connect an AI Agent → Claude Code** in VS Code. It runs this in a terminal you can see:

```bash
claude mcp add --scope local routelens -- "node" "<global storage>/mcp/routelens-mcp.cjs" "--root" "<your project>"
```

"local" scope means it is added for this project, in your own Claude Code settings; nothing is written to the repo. If `claude` is not installed, the command is copied for you instead. Then start `claude` in the project and ask it to test your API.

### Cursor

Run **RouteLens: Connect an AI Agent → Cursor**. It opens Cursor's MCP install link; Cursor shows the server and asks you to confirm.

### Any other agent

**RouteLens: Connect an AI Agent → Copy MCP config** copies the standard JSON:

```json
{
  "mcpServers": {
    "routelens": {
      "command": "node",
      "args": ["<global storage>/mcp/routelens-mcp.cjs", "--root", "<your project>"]
    }
  }
}
```

The server file lives in the extension's global storage, a path that stays the same when the extension updates. Once RouteLens v0.1 is published (M6), `npx -y @routelens/mcp --root .` works too, with nothing installed.

## Options

Add these to the `args` in the agent's config:

| Option                  | What it does                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `--root <folder>`       | The project (default: the folder the agent starts the server in)                                 |
| `--env <name>`          | Default environment (default `local`); every tool also takes `environment`                       |
| `--allow-host <host>`   | Also allow this host. Repeat for more                                                            |
| `--allow-remote-writes` | Don't ask before `POST`/`PUT`/`PATCH`/`DELETE` to hosts that are not this machine. Use with care |
| `--timeout <ms>`        | Timeout of each request (default 30000)                                                          |

**Login:** to let RouteLens log in when a route answers 401, add `ROUTELENS_USERNAME` and `ROUTELENS_PASSWORD` to the server's `env` in the agent's config. Use a test account. The agent never sees them: they are not tool inputs or outputs.

## Safety

An AI agent decides what to send, so RouteLens adds guard rails that the agent can't turn off:

- **Hosts:** requests only go to this machine (`localhost`, `127.0.0.1`, `::1`) or to hosts in your `.routelens/environments/*.env.json` files. Anything else is refused, with the reason.
- **Writes to other machines:** a `POST`, `PUT`, `PATCH` or `DELETE` to a host that is not this machine needs your OK. RouteLens asks you through the agent's app (MCP elicitation), once per host per task. If the app can't ask, the request is refused. You can allow such writes with `--allow-remote-writes`.
- **No server starts:** RouteLens never starts your dev server for an agent. If nothing answers, the agent is told which command starts it, so it can ask you.
- **Files:** the agent can read the route files RouteLens found, inside the project. It can write only flows, to `.routelens/flows/`, and never replaces one unless it asks to.
- **Your agent's own confirmations still apply.** Claude Code, Cursor and Copilot ask before calling tools unless you allowed them; the tools say which ones only read (`list_routes`, `read_route_source`, `get_last_failure`).

## Troubleshooting

- **"Nothing answers on localhost:3000"**: start your dev server (the message says the command), then ask again.
- **No routes:** RouteLens reads Next.js (App Router and `pages/api`) and Express. Check that `next` or `express` is in `package.json`. Code it could not read is listed under `couldNotRead`.
- **A request was "blocked"**: the message says why: a host that is not in your environment files, or a write to another machine that you declined or that the app couldn't ask about.
