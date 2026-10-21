# ADR-0001: Ship as a VS Code extension with an editor-independent core

- Status: Accepted
- Date: 2026-10-21

## Context

RouteLens's main idea is "the API client that reads your code". We considered two forms:

1. A standalone **Electron desktop app** (like Postman, Insomnia, Bruno).
2. A **VS Code extension**.

## Decision

Build a **VS Code extension**, with all real logic in `packages/core`, which never imports `vscode`.

## Why

- The code is already open in the editor. A "▶ Send" CodeLens above each route handler, and failures that jump to the exact line, are only natural inside the editor.
- Distribution is one click (VS Code Marketplace, Open VSX for Cursor and VSCodium). No installers, code signing, or auto-update server.
- The extension host is Node.js, so requests are sent without browser CORS limits, just like a desktop app.
- VS Code gives us SecretStorage (OS keychain), workspace trust, tree views, webviews and CodeLens for free.
- Fits a 4–5 week MVP for one developer.

## Consequences

- UI is limited to what VS Code offers (webviews, tree views, CodeLens, status bar). Good enough for the MVP.
- Users of other editors (JetBrains) are not covered. Open VSX covers Cursor and VSCodium.
- Because the core is editor-independent, a CLI (M4), an MCP server (M4) or even an Electron app later can reuse it without rewriting.
