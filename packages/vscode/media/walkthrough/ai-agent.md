# Let your AI agent test your API

RouteLens has an MCP server: a set of tools your AI agent can call. Ask your agent
"test my API and fix what's broken", and it can:

- **list_routes**: see every route, where its handler is, and a sample body
- **run_all**: run everything, like Test everything
- **get_last_failure**: see what was sent, what came back, and the code of the failing route
- **read_route_source**: read a handler and its zod schema
- **send_request**, **run_flow**, **save_flow**: try a fix, and save a test the agent wrote as a flow you review

**Copilot agent mode** (VS Code 1.101 or newer): already there. Open Chat, pick **Agent**, and look for RouteLens in the tools list.

**Claude Code**: **Connect an AI Agent → Claude Code** runs `claude mcp add` for this project in a terminal you can see.

**Cursor**: **Connect an AI Agent → Cursor** opens Cursor's install link; Cursor asks you to confirm.

**Safety.** Requests only go to this machine or to hosts in your environment files. A `POST`, `PUT`, `PATCH` or `DELETE` to a host that is not this machine needs your OK in the agent's app. RouteLens never starts your server for an agent, and your password is never shown to the agent.
