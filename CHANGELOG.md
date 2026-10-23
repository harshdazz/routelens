# Changelog

RouteLens is released as one version: the VS Code extension, the CLI (`@routelens/cli`) and the MCP server (`@routelens/mcp`) always share the same number. Each section below is also the text of that version's GitHub Release.

## 0.1.0 (2026-10-23)

The first public release: on the VS Code Marketplace, Open VSX and npm.

- **Install from the Marketplace** (or Open VSX for Cursor and VSCodium): search for **RouteLens API Client** by harshdazz. The listing has an icon, the demo and a quick start.
- **The CLI on npm:** `npx @routelens/cli run` runs your requests and flows in the terminal and in CI.
- **The MCP server on npm:** `npx -y @routelens/mcp` gives any AI agent RouteLens's tools, with no path to set up. The extension still sets up Copilot, Claude Code and Cursor for you.

## 0.0.1 (2026-10-22)

The first pre-release, as a `.vsix` on [GitHub Releases](https://github.com/harshdazz/routelens/releases/tag/v0.0.1).

- **Zero setup:** open a JavaScript project and RouteLens finds your API's address, creates `.routelens/` with a first request, and offers to start your dev server when it is off.
- **Reads your code:** every Next.js (App Router and `pages/api`) and Express route gets a request with a sample body from its zod schema, and a ▶ Send button above its handler.
- **Autopilot:** Test everything runs every route and shows a health board. Saving a route file runs its requests again. Logs in by itself after a 401.
- **CI:** `routelens run` runs requests and flows in GitHub Actions, with a JUnit report.
- **AI agents:** an MCP server with 7 tools. Copilot agent mode gets it automatically; **RouteLens: Connect an AI Agent** sets up Claude Code and Cursor.
- **Fixes before the release:** the first request uses a real `GET` route instead of `GET /`, and it is written together with `local.env.json`.
