# Changelog

RouteLens is released as one version: the VS Code extension, the CLI (`@routelens/cli`) and the MCP server (`@routelens/mcp`) always share the same number. Each section below is also the text of that version's GitHub Release.

## 0.1.1 (2026-10-23)

The extension on the VS Code Marketplace and Open VSX.

- **Install from the Marketplace** (or Open VSX for Cursor and VSCodium): search for **RouteLens API Client** by harshdazz. The listing has an icon, the demo and a quick start.
- **New extension ID:** `harshdazz.routelens-api-client`. The Marketplace refused v0.1.0 because another extension already has the name `routelens`.
- **If you installed the v0.0.1 pre-release** (`harshdazz.routelens`): VS Code sees the new ID as a different extension, so uninstall the old one. Your `.routelens/` files and `routelens.*` settings keep working. RouteLens asks once more for logins, the environment and starting your server, and request files you deleted for a route can come back once. If you use Claude Code or Cursor, run **RouteLens: Connect an AI Agent** again.
- The CLI and the MCP server are unchanged since 0.1.0. They keep the extension's version number.

## 0.1.0 (2026-10-23)

The first public release, on npm and GitHub Releases. The Marketplace refused the extension's name, so the extension went there with 0.1.1.

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
