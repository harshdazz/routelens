# RouteLens — Roadmap

Each milestone is a thin slice that works end to end. Target dates assume about 2 hours a day.

Legend: ✅ done · 🟡 in progress · ⬜ not started

**Direction (v2, 2026-10-21):** as little manual work as possible. Plain code does everything it can (zero setup, reads your code, autopilot). AI comes from what the user already has: their AI agent through MCP, VS Code's built-in AI, or a local model in Private mode. See [ADR-0005](decisions/0005-ai-uses-what-the-user-has.md) and [ADR-0006](decisions/0006-zero-setup-detect-and-start-server.md).

> Milestones were renumbered in v2. Older ADRs use the old numbers: old M2 (reads your code) → M3, old M3 (AI) → M7 (the flow runner moved to M4), old M4 (CLI + MCP) → M4 (CLI) and M5 (MCP), old M5 (launch) → M6.

---

## M0 — Foundation ✅ (2026-10-21)

- [x] Project folder and Claude Code notes (kept locally, not in the repo)
- [x] Lifecycle plan, product spec, architecture, ADRs 0001–0004
- [x] pnpm monorepo: `packages/core`, `packages/vscode`
- [x] TypeScript strict, ESLint, Prettier, Vitest, esbuild
- [x] GitHub Actions CI workflow (lint, typecheck, test, build)
- [x] VS Code launch config (F5) and example `.routelens/` folder + demo server

**Acceptance:** `pnpm check` passes locally.

## M1 — Core client ✅ (2026-10-21)

- [x] Request + environment model with zod validation and friendly errors
- [x] `{{variable}}` interpolation with missing-variable report
- [x] Query string building and body serialization (json, text, form)
- [x] HTTP engine: timeout, cancel, timing, size, network/timeout errors
- [x] Read/write/list `.routelens/` files
- [x] Extension: **Send Request** command + "▶ Send request" CodeLens on `.req.json`
- [x] Extension: response panel (status, time, size, headers, pretty body)
- [x] Extension: **New Request** command (name, method, URL → file)
- [x] JSON schema for `.req.json` (autocomplete in the editor)
- [x] Workspace trust: no sending in untrusted workspaces
- [x] Tried by hand in the Extension Development Host against the demo server

The old slice B items moved: environment picker and extension tests → M2; history, Copy as cURL and response panel actions → M8.

**Acceptance:** create, save, send and inspect requests against the demo server without leaving VS Code. ✅

## M2 — Zero setup ✅ (built 2026-10-21, tried by hand 2026-10-22)

Goal: install → click ▶ Send → see the answer. No typed commands, no hand-written setup files ([ADR-0006](decisions/0006-zero-setup-detect-and-start-server.md)).

- [x] Fixture projects for detection: Next.js (default and `-p 3001`), Vite, Express with `PORT` in `.env`, a small monorepo
- [x] Core `detect`: find the server address (open port, `.env`, `package.json` scripts, `listen()` in code) and return the clue used
- [x] Core `detect`: package manager from the lockfile and the `dev` / `start` script
- [x] Core: `isPortOpen` / `waitForPort` (TCP connect, timeout, cancel)
- [x] Activate in any project with a `package.json` (cheap activation, no scanning yet)
- [x] Create `.routelens/` and `local.env.json` automatically; message "Found your API at … (from …) · Change"
- [x] Server off → "▶ Start server": visible terminal, wait up to 60 s with Cancel, send again automatically, report crashes
- [x] Setting `routelens.autoStartServer`: `ask` | `always` | `never` (default `ask`); trusted workspaces only
- [x] Inline result next to Send: `✓ 201 Created · 14 ms`, hover for a body preview, click for the panel
- [x] Environment picker in the status bar (`local` / `staging` …)
- [x] Get Started walkthrough with 3 steps that tick themselves
- [x] Extension tests with `@vscode/test-electron`
- [x] Tried by hand with F5 (Harsh, 2026-10-22: everything worked): "Run RouteLens on the Next.js fixture". Check the message wording, the terminal, the inline result, the status bar and the walkthrough

Details decided while building (detection order, monorepos, tasks, first-click rule) are in the update section of [ADR-0006](decisions/0006-zero-setup-detect-and-start-server.md).

**Acceptance:** on a fresh Next.js fixture with its server off, install → click Send → 200, with no typed commands and no hand-written files. Tests green in CI. ✅ `pnpm test:acceptance` (2026-10-21): real VS Code 1.143, fresh copy of `fixtures/next-default` (Next.js 16), server off → Send → click "▶ Start server" → `next dev` starts → request sent again → `✓ 200 OK`, in about 10 s. `pnpm test:e2e` (8 tests) passes locally and is now a CI step; CI has not run it yet because nothing is pushed.

## M3 — Reads your code ✅ (built 2026-10-21, tried by hand 2026-10-22; target was 2026-11-04)

Reads code with the TypeScript parser and never runs it ([ADR-0007](decisions/0007-route-scanner-static-parsing.md)).

- [x] Fixture projects: Next.js App Router, Next.js Pages API, Express (`fixtures/next-app-routes`, `next-pages-api`, `express-routes`)
- [x] Scanner: Next.js App Router (`app/**/route.ts` exported methods, dynamic `[id]` segments)
- [x] Scanner: Pages API (`pages/api/**`)
- [x] Scanner: Express (`app.get`, `router.post`, mounted routers)
- [x] zod body schema → valid sample body
- [x] A draft request is created automatically for every detected route
- [x] "▶ Send" CodeLens above each detected route handler
- [x] Routes tree view in the sidebar
- [x] Drift: when a route changes, its draft request updates itself (fields the user edited are kept)
- [x] Tried by hand with F5 (Harsh, 2026-10-22: 14 routes, Could not read 1, ▶ Send buttons, drift kept the edit): open `fixtures/express-routes` in the F5 window. Check the Routes view, the ▶ Send buttons, the "found N routes" message and a drift edit

Details decided while building (fingerprints in the `route` field, renames, deleted drafts, trust) are in [ADR-0007](decisions/0007-route-scanner-static-parsing.md).

**Acceptance:** 95%+ of fixture routes detected; a sample body passes the route's own zod validation. ✅ (2026-10-21) 36 of 36 fixture routes detected (`scan.test.ts` checks each one). All 10 routes that validate with zod get a sample that their own schema accepts: `routeSamples.test.ts` loads the real schema from the fixture and runs it with the real zod. `zodSample.test.ts` checks about 100 more zod expressions the same way. `pnpm test:e2e` (12 tests, real VS Code 1.143) covers scanning, ▶ Send on a route and drift.

## M4 — Autopilot ✅ (built 2026-10-21, tried by hand and green in CI 2026-10-22; target was 2026-11-11)

[ADR-0008](decisions/0008-autopilot-runner-flows-login.md)

- [x] "Test everything": run every route and show a health board (e.g. 10 ✓, 2 ✗) in the sidebar
- [x] Watch mode: saving a route file re-runs its requests and updates the inline ✓/✗
- [x] Auto-login for protected routes: find the login route, log in once, reuse the token (kept in memory or SecretStorage, never in files)
- [x] Flow format `.flow.json` (steps, extracted values, assertions) and a deterministic flow runner (no AI)
- [x] `packages/cli`: `routelens run` (flows + requests, JUnit output). Package name `@routelens/cli`, because `routelens` is the extension's name in this repo
- [x] GitHub Action example workflow (`examples/github-actions/routelens.yml`), and CI runs the CLI on `examples/`
- [x] Rescan cache: unchanged files are not parsed again (needed for "within 2 seconds" on big projects)
- [x] Tried by hand with F5 (Harsh, 2026-10-22: done): Test everything on `examples/` with the demo server (login `demo@routelens.dev` / `demo-password`), ▶ Run flow, then save a route file in a fixture after a run
- [x] First CI run on GitHub (2026-10-22): the first two runs found two Linux-only problems (stopping a `--start` dev server; a race between `local.env.json` and the first request), both fixed; green from `883aea8`, including `routelens run examples` against the demo server

**Acceptance:** on the fixtures, one click runs every detected route; saving a route file re-runs its tests within 2 seconds; a sample repo runs its flows in GitHub Actions. ✅ (2026-10-21, CI 2026-10-22) `pnpm test:e2e` (15 tests, real VS Code 1.143): Test everything ran every route, the first request and a flow (6 passed, 0 failed), asking for the login once; ▶ Run flow passed; saving `routes.js` ran its request again about 300 ms after the save. The built CLI ran `examples/` against the demo server: 9 passed with `ROUTELENS_USERNAME`/`ROUTELENS_PASSWORD`, 7 passed and 2 failed (the 401s) without, with a JUnit report. GitHub Actions runs the same command on every push (`examples/` with its flow and the demo login): green since `883aea8`.

## M5 — MCP: any AI agent can drive RouteLens ✅ (built 2026-10-21, Claude Code and Copilot checks 2026-10-21/22; target was 2026-11-18)

[ADR-0009](decisions/0009-mcp-server-for-ai-agents.md)

- [x] `packages/mcp` with `@modelcontextprotocol/sdk` 1.32.1: `list_routes`, `read_route_source`, `send_request`, `run_all`, `run_flow`, `save_flow`, `get_last_failure`
- [x] Guard rails: only hosts from the project's environment files by default; non-local `POST`/`PUT`/`PATCH`/`DELETE` need confirmation (MCP elicitation; refused when the app can't ask, unless `--allow-remote-writes`)
- [x] Extension registers the MCP server with VS Code automatically. `engines.vscode` stays `^1.95.0`: the API is used when the editor has it (1.101+)
- [x] One-click setup for Claude Code and Cursor ("RouteLens: Connect an AI Agent")
- [x] Tests: MCP SDK in-memory client against the fixtures, plus the built bundle over stdio
- [x] Docs: [using RouteLens from Claude Code, Cursor and Copilot agent mode](using-with-ai-agents.md)
- [x] Planted-bug fixture `fixtures/buggy-api` and a scripted acceptance test (`pnpm test:acceptance:mcp`)
- [x] Real Claude Code run on a copy of `fixtures/buggy-api` (2026-10-21, see the acceptance note)
- [x] Tried by hand (Harsh, 2026-10-22): Copilot agent mode in VS Code on a copy of `fixtures/buggy-api`, asked "test my API and fix what's broken"

**Acceptance:** on a fixture with a planted bug, Claude Code and Copilot agent mode can "test my API and fix what's broken": list routes, run them, read the failing route and propose the fix. 🟡 (2026-10-21) The scripted agent (`pnpm test:acceptance:mcp`, real `npm ci` and server) does exactly these steps through the MCP tools: `list_routes` finds the 6 routes with no setup, `run_all` reports 5 passed and 1 failed (`GET /api/todos/:id`), `get_last_failure` returns the 404 and the handler's code with the buggy line, and after the fix `run_all` passes 6 of 6. `pnpm test:e2e` (17 tests, VS Code 1.143) starts the server the way VS Code registers it for Copilot (VS Code's own Node) and the way the Claude Code/Cursor config does (`node`), and lists the routes over stdio. **Real Claude Code run** (2026-10-21, Claude Code 2.1.266, Opus 5): connected with the exact `claude mcp add --scope local` command "Connect an AI Agent" runs, then `claude -p "Test my API and fix what's broken."` in a copy of the fixture (server under `node --watch`; RouteLens tools, Read and Edit pre-approved). It called `list_routes` → `run_all` (5 passed, 1 failed) → `get_last_failure` → read `src/routes/todos.js` → fixed line 24 with `Number(req.params.id)` "to match the siblings" → `send_request` (200) → `run_all` (6 of 6). It then probed past the samples and fixed two real issues RouteLens's samples don't cover (ids reused after a delete; invalid bodies answering 500 with a stack trace). 28 turns, 161 s, $1.32. Two findings fixed right after: the fixture's `package.json` named the "planted bug" (now neutral), and a correct 400 from a probe without `expect` read as ✗ (`send_request` now says how to expect it). **Copilot agent mode** (2026-10-22, VS Code 1.143 with the packaged `.vsix`, Auto → gpt-6-luna, by Harsh): VS Code started the RouteLens MCP server on its own (`Discovered 7 tools` in its MCP log), Copilot used the RouteLens tools, fixed line 24 with `Number(req.params.id)`, and also fixed the id reuse after a delete (`nextTodoId`). Checked afterwards against the fixed code: `GET /api/todos/1` → 200; after `DELETE /api/todos/1` a new todo gets id 3, not a duplicate. Note: Copilot only sees the tools when the extension is installed; the F5 window can't be used, because it starts with other extensions turned off.

## M6 — Launch v0.1 ⬜ (target 2026-11-25)

- [ ] README with demo GIF (install → click Send → autopilot → AI agent fixes a bug), screenshots, quick start
- [ ] Marketplace + Open VSX publish, v0.1.0, CHANGELOG
- [ ] Landing page (Next.js) with the demo
- [ ] LinkedIn launch post + GitHub repo polish (topics, description, pinned)
- [ ] Get 5 real users to try it; log feedback

## M7 — Built-in AI brain, v0.2 ⬜ (target 2026-12-02)

- [ ] Core `ModelProvider` interface; adapters for Ollama (OpenAI-compatible endpoint) and API keys (Anthropic, OpenAI)
- [ ] Extension adapter for VS Code's built-in language model (Copilot)
- [ ] Automatic brain choice: VS Code AI → Ollama on `localhost:11434` → API key → none ("Add AI" button)
- [ ] Private mode: local models only; test that nothing except the user's own requests leaves the machine
- [ ] "Explain failure" on red results: request + response + route source + dev-server output → cause, fix, link to the line
- [ ] English → `.flow.json` (AI writes once, plain code replays, [ADR-0004](decisions/0004-ai-writes-once-replay-deterministic.md))
- [ ] Realistic test data from schemas
- [ ] Recorded-response tests; manual eval set of 10 scenarios, run on Copilot and on one Ollama model
- [ ] Privacy notice: what is sent, to whom, for each brain

**Acceptance:** 7 of 10 eval scenarios produce a flow that passes on first replay; Explain failure works with Copilot and with Ollama; Private mode verified.

## M8 — Essentials, v0.3 ⬜ (target 2026-12-09)

Manual tools for when automation isn't enough.

- [ ] Request form editor (method, URL, headers and query tables, body) that saves the `.req.json` file
- [ ] File upload (multipart form-data)
- [ ] Request history (last 50 responses, in extension storage)
- [ ] Copy as cURL and paste a cURL command as a new request
- [ ] Cookies (per-environment cookie jar)
- [ ] Response panel: copy body, search, raw/pretty toggle

## Stretch (parked)

- Import from Postman collections and OpenAPI files
- AI endpoint testing: streaming (SSE) viewer, token cost per call, meaning-based assertions
- Mock mode: fake responses from route schemas while the backend isn't ready
- `npx routelens` local web UI for people who don't use VS Code
- More frameworks: Fastify, Hono, NestJS
- Self-signed HTTPS on localhost, proxy settings
- GraphQL, WebSockets
