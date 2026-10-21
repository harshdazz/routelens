# RouteLens — Architecture

_Status: v2 · 2026-10-21 (zero setup, autopilot, MCP and AI brains added)_

## Big picture

```
 AI agents (Claude Code, Cursor, Copilot agent mode)
        │  MCP
        ▼
 packages/mcp  (M5) ─────────────┐        packages/cli  (M4)
                                 │                │
┌──────────────────────── VS Code ───────────────────────────┐
│                                │                │          │
│  packages/vscode  (extension host, Node.js)     │          │
│   ├─ Commands: New Request, Send Request, Test Everything  │
│   ├─ CodeLens: "▶ Send" + inline result (✓ 201 · 14 ms)    │
│   ├─ Server manager: start dev server in a terminal (M2)   │
│   ├─ Status bar environment picker, walkthrough (M2)       │
│   ├─ Routes tree + health board (M3–M4)                    │
│   ├─ Response panel (webview, strict CSP)                  │
│   ├─ MCP server registration (M5)                          │
│   ├─ vscode.lm adapter: Copilot models (M7)                │
│   ├─ SecretStorage: AI keys, login tokens                  │
│   └─ calls ↓                                               │
│                                ▼                ▼          │
│  packages/core  (pure TypeScript, no vscode import)        │
│   ├─ model      zod schemas for requests & environments    │
│   ├─ variables  {{var}} interpolation, request resolving   │
│   ├─ send       HTTP engine (Node fetch / undici)          │
│   ├─ storage    read/write .routelens/ files               │
│   ├─ detect     server address, package manager, ports (M2)│
│   ├─ scanner    find routes in Next.js / Express (M3)      │
│   ├─ runner     run all, flows, assertions — no AI (M4)    │
│   └─ agent      ModelProvider + AI tasks (M7)              │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Why this split:** the core can be tested without VS Code, and the same code powers the CLI, the GitHub Action and the MCP server (see [ADR-0001](decisions/0001-vscode-extension.md)).

**Plain code first:** detection, scanning, running and replaying never call an AI model. AI is only in `agent` (M7) and in the user's own agent through MCP (M5) ([ADR-0005](decisions/0005-ai-uses-what-the-user-has.md)).

## Files on disk

Everything a user creates lives in their repo, under `.routelens/` (see [ADR-0003](decisions/0003-request-file-format.md)). RouteLens creates this folder by itself on first use (M2).

```
my-app/
└─ .routelens/
   ├─ requests/
   │  ├─ get-health.req.json
   │  └─ create-post.req.json
   ├─ environments/
   │  ├─ local.env.json      (written by RouteLens from the detected address)
   │  └─ staging.env.json
   └─ flows/                 (M4)
      └─ signup-and-post.flow.json
```

Request file (version 1):

```json
{
  "version": 1,
  "name": "Create post",
  "method": "POST",
  "url": "{{baseUrl}}/api/posts",
  "headers": { "Content-Type": "application/json" },
  "query": {},
  "body": { "type": "json", "content": { "title": "Hello" } }
}
```

Environment file (version 1). **No secrets here**: this file is committed.

```json
{ "version": 1, "name": "local", "variables": { "baseUrl": "http://localhost:4000" } }
```

## Main flow: sending a request (M1, done)

1. User clicks **▶ Send request** above a `.req.json` file (CodeLens) or runs **RouteLens: Send Request**.
2. Extension reads the editor text (so unsaved edits are used) and calls `parseRequest` in core (zod validation, friendly errors).
3. Extension loads the active environment (`routelens.environment` setting, default `local`).
4. Core `resolveRequest` replaces `{{variables}}`, builds the query string and serializes the body. Missing variables are reported, and the user can cancel.
5. Core `sendRequest` sends it with Node's fetch, a timeout and a cancel signal; it measures time and size and returns a plain response object.
6. Extension renders the response in a webview panel beside the editor.

## Zero setup flow (M2)

Added in front of the main flow ([ADR-0006](decisions/0006-zero-setup-detect-and-start-server.md)):

1. **No `.routelens/` yet?** On activation (any folder with a `package.json`, trusted workspaces only, once per folder), core `detectServer` finds the server address. In a monorepo it first picks the workspace package that looks like the API. Clues, best first: a port from the clues below that is already open → a port in the `dev`/`start` script (`-p 3001`) → `.env.local` / `.env` `PORT=` → the tool's default port (`next dev` → 3000) → `listen()` in the entry file. It returns the address plus the clue used. Core `createProjectFiles` writes `local.env.json` and a first request; the extension shows "Found your API at … (from …) · Change".
2. **Before sending**, core `localServerOf` checks whether the URL points at this machine, and `isPortOpen` makes a ~300 ms TCP connect to it.
3. **Port closed?** The extension offers "▶ Start server" (or starts right away when `routelens.autoStartServer` is `always` and the user clicked Start once in this workspace). Core `detectServer` also returns the start command: package manager from Corepack's field or the lockfile, script `dev`, else `start`. The extension runs it as a VS Code task in a visible terminal, and core `waitForPort` waits up to 60 s (cancellable, and stopped early if the process exits). Then the request is sent again. If the process exits, RouteLens says so and offers to show the terminal.
4. **After sending**, the CodeLens shows the inline result (`✓ 201 Created · 14 ms`, hover for a body preview), with the full panel one click away.

Files: `packages/core/src/detect/` (detection), `packages/core/src/ports.ts` (port checks), `packages/vscode/src/setup.ts`, `serverManager.ts`, `codeLens.ts`, `environments.ts`. Tests: `packages/core/test/detect.test.ts` runs detection on the projects in `fixtures/`; `pnpm test:e2e` and `pnpm test:acceptance` run the extension in a real VS Code.

## Planned flows

- **Scan routes (M3):** `ts-morph` parses the project → finds `app/**/route.ts` exports (`GET`, `POST`…), `pages/api/**`, and `app.get()/router.post()` calls → reads zod schemas used for the body → creates draft requests with sample bodies → shows them in a tree view and as CodeLens above each handler. When a route changes, its draft updates (user-edited fields kept).
- **Autopilot (M4):** "Test everything" runs every route through core `runner` and shows a health board. A file watcher re-runs the requests of a route file when it is saved. Auto-login runs the login request once and keeps the token in memory or SecretStorage. Flows (`.flow.json`) replay with plain code. `packages/cli` runs the same runner in CI.
- **MCP (M5):** `packages/mcp` exposes core functions as tools (`list_routes`, `read_route_source`, `send_request`, `run_all`, `run_flow`, `save_flow`, `get_last_failure`). The extension registers it with VS Code automatically, and setup for Claude Code and Cursor is one click. The user's agent does the thinking.
- **Built-in AI (M7):** core defines a `ModelProvider` interface. Brains are chosen automatically: VS Code language model (Copilot, through an extension adapter) → Ollama on `localhost:11434` → API key → none. Private mode allows local models only.
  - **English → flow:** the agent explores with the same tools as MCP, then writes a `.flow.json` with plain steps. **Replaying a flow never calls the AI** ([ADR-0004](decisions/0004-ai-writes-once-replay-deterministic.md)).
  - **Explain failure:** on a 4xx/5xx, collect the request, response, matching route source and recent dev-server output → ask the model for cause + fix → show it with a link to the code line.

## Security model

| Concern                   | Decision                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets (AI keys, tokens) | VS Code `SecretStorage` (OS keychain) or memory. Never written to `.routelens/`.                                                                                                                   |
| Webview                   | Strict CSP with a nonce, no remote scripts, all values HTML-escaped. The M1 panel renders static HTML (no script at all).                                                                          |
| Files from the repo       | Parsed with zod. Invalid files show a clear error and are never executed.                                                                                                                          |
| Starting the dev server   | Trusted workspaces only; only the `dev` / `start` scripts from `package.json`, never commands from `.routelens` files; the first start in each workspace needs a click; always a visible terminal. |
| MCP tools                 | Only hosts from the project's environment files by default; non-local `POST`/`PUT`/`PATCH`/`DELETE` need the user's confirmation; no file access outside the workspace.                            |
| AI data                   | Sent only to the brain in use (the user's agent, Copilot, Ollama or their API key), and the UI says which one. Private mode allows local models only. A notice explains what is sent.              |
| Requests                  | Sent from the extension host (Node), so there are no browser CORS limits. The user is responsible for the URLs they call.                                                                          |
| Workspace trust           | Untrusted workspaces: read-only features only (no sending, no server start). Scanning never executes user code.                                                                                    |

## Tech choices (summary)

| Area              | Choice                                     | Why                                                                             |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Language          | TypeScript (strict)                        | Matches Harsh's stack, safer refactors                                          |
| Monorepo          | pnpm workspaces                            | Fast, strict dependency isolation ([ADR-0002](decisions/0002-pnpm-monorepo.md)) |
| Validation        | zod                                        | Same library users already use in their routes; schemas double as types         |
| HTTP              | Node fetch (undici)                        | Built in, supports AbortSignal, no extra dependency                             |
| Port checks (M2)  | `node:net`                                 | Built in; a TCP connect is the fastest "is it up?" check                        |
| Bundling          | esbuild                                    | One fast step, small extension bundle                                           |
| Tests             | Vitest                                     | Fast, TypeScript-native                                                         |
| Code parsing (M3) | ts-morph                                   | Friendly wrapper over the TypeScript compiler API                               |
| MCP (M5)          | `@modelcontextprotocol/sdk`                | Official SDK                                                                    |
| AI (M7)           | VS Code Language Model API + Vercel AI SDK | Copilot models with no key; one API for Anthropic, OpenAI and Ollama            |
