# @routelens/mcp

The RouteLens MCP server: lets AI agents (Copilot agent mode, Claude Code, Cursor, any MCP client) list your API routes, run them, read what failed with the route's code, and save flows. It speaks MCP on stdio.

> Pre-alpha. Not on npm yet: it is published with RouteLens v0.1 (M6). Until then, the VS Code extension sets agents up for you ("RouteLens: Connect an AI Agent"), or build it with `pnpm --filter @routelens/mcp build` and run `node packages/mcp/dist/routelens-mcp.cjs`.

```json
{
  "mcpServers": {
    "routelens": { "command": "npx", "args": ["-y", "@routelens/mcp", "--root", "."] }
  }
}
```

Tools: `list_routes`, `read_route_source`, `send_request`, `run_all`, `run_flow`, `save_flow`, `get_last_failure`. Options: `--root`, `--env`, `--allow-host`, `--allow-remote-writes`, `--timeout`. Login: `ROUTELENS_USERNAME` / `ROUTELENS_PASSWORD` in the server's environment.

Requests only go to this machine and to hosts in the project's environment files. `POST`/`PUT`/`PATCH`/`DELETE` to other hosts need the person's OK through the agent's app. The server never starts your dev server.

See [Using RouteLens with AI agents](../../docs/using-with-ai-agents.md) and [ADR-0009](../../docs/decisions/0009-mcp-server-for-ai-agents.md).
