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
│   ├─ Routes view, ▶ Send above handlers (M3), health (M4)  │
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
│   ├─ scanner    routes, zod samples, drafts (M3)           │
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
      └─ create-and-read-post.flow.json
```

Request file (version 1). `route` is only there when RouteLens made the request from a route in the code (M3):

```json
{
  "version": 1,
  "name": "Create post",
  "method": "POST",
  "url": "{{baseUrl}}/api/posts",
  "headers": { "Content-Type": "application/json" },
  "query": {},
  "body": { "type": "json", "content": { "title": "Hello" } },
  "route": {
    "key": "POST /api/posts",
    "file": "app/api/posts/route.ts",
    "generated": { "body/title": "5d41402a", "name": "1f0e3dad", "url": "8f14e45f" }
  }
}
```

A request may also have an `expect` block (M4) saying what the response must look like; without it, a status below 400 passes. Flows list steps that run in order and pass values on ([ADR-0008](decisions/0008-autopilot-runner-flows-login.md)):

```json
{
  "version": 1,
  "name": "Create a post and read it back",
  "steps": [
    { "request": "create-post", "extract": { "postId": "body.id" }, "expect": { "status": 201 } },
    {
      "request": { "method": "GET", "url": "{{baseUrl}}/api/posts/{{postId}}" },
      "expect": { "values": { "body.id": "{{postId}}" } }
    }
  ]
}
```

`route.generated` holds short fingerprints of the values RouteLens wrote, so it can update them when the route changes without overwriting the user's edits ([ADR-0007](decisions/0007-route-scanner-static-parsing.md)).

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

## Reads your code (M3)

[ADR-0007](decisions/0007-route-scanner-static-parsing.md). The scanner reads code with the TypeScript parser and never runs it.

1. **When:** after activation (once zero setup is done), whenever a source file or a request file changes (400 ms debounce), and from the ↻ button in the Routes view. The TypeScript parser (~3.5 MB) is loaded by the first scan, not on activation.
2. **What:** core `findServerDir` picks the package to scan (the API package in a monorepo). Core `scanRoutes` reads `package.json` to choose the frameworks, lists the source files (skipping `node_modules`, build output and tests), and runs:
   - `next.ts`: App Router route handlers (`app/**/route.ts`, one route per exported method) and Pages API routes (`pages/api/**`, methods from `req.method` checks)
   - `express.ts`: a graph of apps and routers (`express()`, `Router()`), their routes, and `app.use(prefix, router)` mounts across files
   - `body.ts` + `zod.ts`: the zod schema a handler parses its body with (or passes to a middleware), turned into a sample value; without zod, the fields it destructures from the body
   - `project.ts`: follows imports and exports (ESM and CommonJS) with TypeScript's own module resolution, so `@/lib/schemas` and `./users.js` → `users.ts` work. It never reads outside the workspace folder.
3. **Drafts:** core `syncRouteDrafts` creates one `.req.json` per new route and updates the others key by key using the fingerprints (user edits are kept, renames are followed, requests whose route is gone are listed and never deleted). Only in trusted workspaces with `.routelens/`; drafts open with unsaved changes are skipped.
4. **UI:** a **Routes** view in the RouteLens sidebar (route, last result, "No longer in the code", "Could not read"), and a "▶ Send POST /api/posts" CodeLens above each handler, with the inline result next to it. ▶ Send makes the draft if it is missing, then runs the normal send flow (including starting the server).

Files: `packages/core/src/scanner/`, `packages/vscode/src/routeIndex.ts`, `routeCodeLens.ts`, `routesView.ts`, `commands/routes.ts`. Tests: `packages/core/test/scan.test.ts` (every fixture route), `zodSample.test.ts` (each sample checked by the real zod), `routeSamples.test.ts` (M3 acceptance), `drafts.test.ts`; `pnpm test:e2e` covers scanning, ▶ Send on a route and drift in a real VS Code.

## Autopilot (M4)

[ADR-0008](decisions/0008-autopilot-runner-flows-login.md). One runner in core, used by the extension, the CLI and (M5) the MCP server, so they agree on what "passed" means.

1. **Runner** (`packages/core/src/runner/`): `runRequest` resolves variables, sends, and checks the response against `expect` (`expect.ts`: status, partial body, value paths with matchers, time). `runFlow` runs steps in order, saves `extract` values (typed: `"{{postId}}"` stays a number in JSON bodies), and stops at the first failing step. `valuePath.ts` reads paths like `body.items[0].id`. No AI anywhere.
2. **Auto-login** (`auth.ts`): `findLoginRequest` picks the saved request that logs in (a POST to `/login`, `/signin`, `/auth/login`, `/session`, `/token`… with a password field). On a 401 from the same server, `AuthSession` logs in once, finds the token (a token field in the JSON, or the cookies) and sends again. The token only goes to the origin it came from; requests that expect a 401 are left alone.
3. **Test everything** (`packages/vscode/src/testRunner.ts`): makes missing route drafts, checks the server (offers to start it), asks before writes to a non-local server, then runs every request (reads first, deletes last) and every flow, one at a time, with progress and Cancel. Results go to the same store as ▶ Send, so the inline ✓/✗, the Routes view and the board (summary line and view description) update live.
4. **Watch mode**: on save of a source file with routes, rescan it (the parse cache makes this one file), then run again the drafts of its routes that already have a result. If the dev server is restarting, wait up to 5 s for the port and try once more. Setting `routelens.runOnSave`.
5. **Logins in VS Code** (`logins.ts`): one `AuthSession` per project and environment. The username and password are asked on the first 401 and kept in SecretStorage; the token stays in memory. **RouteLens: Log Out** forgets both.
6. **CLI** (`packages/cli`): `routelens run [folder]` reads the same files and calls the same runner. Variables come from the environment file, `ROUTELENS_VAR_<name>` and `--var`; the login from `ROUTELENS_USERNAME` / `ROUTELENS_PASSWORD`. `--start` runs the `dev`/`start` script (as zero setup does) and stops it at the end; `--junit` writes a report; in GitHub Actions failures become annotations. Exit code 0 / 1 / 2.

Files: `packages/core/src/runner/`, `packages/vscode/src/testRunner.ts`, `logins.ts`, `routesView.ts`, `packages/cli/src/`. Tests: `packages/core/test/runner.test.ts` and `expect.test.ts` (against a real local API with a login), `packages/cli/test/cli.test.ts` (in-process, including a real `--start`), `pnpm test:e2e` (Test everything with one login prompt, Run Flow, re-run within 2 s of a save). CI runs `routelens run examples` against the demo server.

## Works with your AI agent (M5)

[ADR-0009](decisions/0009-mcp-server-for-ai-agents.md). `packages/mcp` is an MCP server on stdio (`routelens-mcp --root <project>`), built on `@modelcontextprotocol/sdk`. Its tools call core, like the board and the CLI.

1. **Tools:** `list_routes` (scanner + saved requests + flows + environment), `read_route_source` (handler code with line numbers, an arrow on the handler's line, and the zod schema), `send_request`, `run_all` (saved requests, an in-memory draft for each route without one, flows), `run_flow` and `save_flow` (a flow the agent wrote, validated with the flow schema), `get_last_failure` (what was sent, the response, failed checks, and the route's code; `matchRoute` finds the route of an ad-hoc URL).
2. **No setup needed:** without `.routelens/`, the address comes from `detectServer` and routes run from in-memory drafts. Nothing is written except by `save_flow`.
3. **Guard rails** (`guard.ts`, through core's `beforeSend` hook on every request): only this machine and hosts from environment files (plus `--allow-host`); `POST`/`PUT`/`PATCH`/`DELETE` to other hosts ask the person through MCP elicitation (once per host per tool call), and are refused when the app can't ask, unless `--allow-remote-writes`. No server starts. Login only from `ROUTELENS_USERNAME`/`ROUTELENS_PASSWORD`.
4. **Setup:** the extension registers one server per trusted folder with `vscode.lm.registerMcpServerDefinitionProvider` when the editor has it (VS Code 1.101+), run by VS Code's own Node (`ELECTRON_RUN_AS_NODE=1`) on `dist/mcp-server.js`. "Connect an AI Agent" copies that file to global storage (a path that survives updates) and runs `claude mcp add --scope local …`, opens Cursor's install link, or copies the `mcpServers` JSON.

Files: `packages/mcp/src/` (`server.ts`, `guard.ts`, `project.ts`, `format.ts`, `bin.ts`), `packages/vscode/src/agents.ts`, `agentSetup.ts`. Tests: `packages/mcp/test/server.test.ts` (the SDK's in-memory client: every tool, the guard rails with and without elicitation, auto-login, flows), `stdio.test.ts` (the built bundle as a child process), `test/acceptance/buggy-api.test.ts` (`pnpm test:acceptance:mcp`), and `pnpm test:e2e`.

## Planned flows

- **Built-in AI (M7):** core defines a `ModelProvider` interface. Brains are chosen automatically: VS Code language model (Copilot, through an extension adapter) → Ollama on `localhost:11434` → API key → none. Private mode allows local models only.
  - **English → flow:** the agent explores with the same tools as MCP, then writes a `.flow.json` with plain steps. **Replaying a flow never calls the AI** ([ADR-0004](decisions/0004-ai-writes-once-replay-deterministic.md)).
  - **Explain failure:** on a 4xx/5xx, collect the request, response, matching route source and recent dev-server output → ask the model for cause + fix → show it with a link to the code line.

## Security model

| Concern                   | Decision                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Secrets (AI keys, tokens) | VS Code `SecretStorage` (OS keychain) or memory. Never written to `.routelens/`. Logins: username and password in SecretStorage, token in memory, sent only to the origin that issued it. CI: environment variables.                                                                                                                       |
| Webview                   | Strict CSP with a nonce, no remote scripts, all values HTML-escaped. The M1 panel renders static HTML (no script at all).                                                                                                                                                                                                                  |
| Files from the repo       | Parsed with zod. Invalid files show a clear error and are never executed.                                                                                                                                                                                                                                                                  |
| Starting the dev server   | Trusted workspaces only; only the `dev` / `start` scripts from `package.json`, never commands from `.routelens` files; the first start in each workspace needs a click; always a visible terminal.                                                                                                                                         |
| MCP tools                 | Only this machine and hosts from the project's environment files by default; non-local `POST`/`PUT`/`PATCH`/`DELETE` need the user's OK (MCP elicitation, refused when the app can't ask); never starts servers; reads only route files inside the root and writes only `.routelens/flows/`; passwords only from the server's environment. |
| AI data                   | Sent only to the brain in use (the user's agent, Copilot, Ollama or their API key), and the UI says which one. Private mode allows local models only. A notice explains what is sent.                                                                                                                                                      |
| Requests                  | Sent from the extension host (Node), so there are no browser CORS limits. The user is responsible for the URLs they call.                                                                                                                                                                                                                  |
| Test everything / CLI     | Runs only files from `.routelens/`, one request at a time. Asks before writes to a non-local server. The CLI starts a server only with `--start`, and only the `dev`/`start` script.                                                                                                                                                       |
| Workspace trust           | Untrusted workspaces: read-only features only (no sending, no server start). Scanning never executes user code.                                                                                                                                                                                                                            |

## Tech choices (summary)

| Area              | Choice                                     | Why                                                                                                                      |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Language          | TypeScript (strict)                        | Matches Harsh's stack, safer refactors                                                                                   |
| Monorepo          | pnpm workspaces                            | Fast, strict dependency isolation ([ADR-0002](decisions/0002-pnpm-monorepo.md))                                          |
| Validation        | zod                                        | Same library users already use in their routes; schemas double as types                                                  |
| HTTP              | Node fetch (undici)                        | Built in, supports AbortSignal, no extra dependency                                                                      |
| Port checks (M2)  | `node:net`                                 | Built in; a TCP connect is the fastest "is it up?" check                                                                 |
| Bundling          | esbuild                                    | One fast step, small extension bundle                                                                                    |
| Tests             | Vitest                                     | Fast, TypeScript-native                                                                                                  |
| Code parsing (M3) | TypeScript compiler API, parser only       | Same parser as the user's build, plus its module resolution ([ADR-0007](decisions/0007-route-scanner-static-parsing.md)) |
| CLI (M4)          | `node:util` `parseArgs`, esbuild bundle    | No CLI framework needed; one file to publish ([ADR-0008](decisions/0008-autopilot-runner-flows-login.md))                |
| MCP (M5)          | `@modelcontextprotocol/sdk`                | Official SDK                                                                                                             |
| AI (M7)           | VS Code Language Model API + Vercel AI SDK | Copilot models with no key; one API for Anthropic, OpenAI and Ollama                                                     |
