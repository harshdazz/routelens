# RouteLens — Roadmap

Each milestone is a thin slice that works end to end. Target dates assume about 2 hours a day.

Legend: ✅ done · 🟡 in progress · ⬜ not started

**Direction (v2, 2026-10-21):** as little manual work as possible. Plain code does everything it can (zero setup, reads your code, autopilot). AI comes from what the user already has: their AI agent through MCP, VS Code's built-in AI, or a local model in Private mode. See [ADR-0005](decisions/0005-ai-uses-what-the-user-has.md) and [ADR-0006](decisions/0006-zero-setup-detect-and-start-server.md).

> Milestones were renumbered in v2. Older ADRs use the old numbers: old M2 (reads your code) → M3, old M3 (AI) → M7 (the flow runner moved to M4), old M4 (CLI + MCP) → M4 (CLI) and M5 (MCP), old M5 (launch) → M6.

---

## M0 — Foundation ✅ (2026-10-21)

- [x] Project folder, CLAUDE.md, MEMORY.md
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

## M2 — Zero setup 🟡 built and verified, F5 hand check left (2026-10-21)

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
- [ ] Tried by hand with F5 (Harsh): "Run RouteLens on the Next.js fixture". Check the message wording, the terminal, the inline result, the status bar and the walkthrough

Details decided while building (detection order, monorepos, tasks, first-click rule) are in the update section of [ADR-0006](decisions/0006-zero-setup-detect-and-start-server.md).

**Acceptance:** on a fresh Next.js fixture with its server off, install → click Send → 200, with no typed commands and no hand-written files. Tests green in CI. ✅ `pnpm test:acceptance` (2026-10-21): real VS Code 1.143, fresh copy of `fixtures/next-default` (Next.js 16), server off → Send → click "▶ Start server" → `next dev` starts → request sent again → `✓ 200 OK`, in about 10 s. `pnpm test:e2e` (8 tests) passes locally and is now a CI step; CI has not run it yet because nothing is pushed.

## M3 — Reads your code 🟡 built and verified, F5 hand check left (2026-10-21, target was 2026-11-04)

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
- [ ] Tried by hand with F5 (Harsh): open `fixtures/express-routes` in the F5 window. Check the Routes view, the ▶ Send buttons, the "found N routes" message and a drift edit

Details decided while building (fingerprints in the `route` field, renames, deleted drafts, trust) are in [ADR-0007](decisions/0007-route-scanner-static-parsing.md).

**Acceptance:** 95%+ of fixture routes detected; a sample body passes the route's own zod validation. ✅ (2026-10-21) 36 of 36 fixture routes detected (`scan.test.ts` checks each one). All 10 routes that validate with zod get a sample that their own schema accepts: `routeSamples.test.ts` loads the real schema from the fixture and runs it with the real zod. `zodSample.test.ts` checks about 100 more zod expressions the same way. `pnpm test:e2e` (12 tests, real VS Code 1.143) covers scanning, ▶ Send on a route and drift.

## M4 — Autopilot ⬜ (target 2026-11-11)

- [ ] "Test everything": run every route and show a health board (e.g. 10 ✓, 2 ✗) in the sidebar
- [ ] Watch mode: saving a route file re-runs its requests and updates the inline ✓/✗
- [ ] Auto-login for protected routes: find the login route, log in once, reuse the token (kept in memory or SecretStorage, never in files)
- [ ] Flow format `.flow.json` (steps, extracted values, assertions) and a deterministic flow runner (no AI)
- [ ] `packages/cli`: `npx routelens run` (flows + requests, JUnit output)
- [ ] GitHub Action example workflow

**Acceptance:** on the fixtures, one click runs every detected route; saving a route file re-runs its tests within 2 seconds; a sample repo runs its flows in GitHub Actions.

## M5 — MCP: any AI agent can drive RouteLens ⬜ (target 2026-11-18)

- [ ] `packages/mcp` with `@modelcontextprotocol/sdk`: `list_routes`, `read_route_source`, `send_request`, `run_all`, `run_flow`, `save_flow`, `get_last_failure`
- [ ] Guard rails: only hosts from the project's environment files by default; non-local `POST`/`PUT`/`PATCH`/`DELETE` need confirmation
- [ ] Extension registers the MCP server with VS Code automatically (raise `engines.vscode` as needed)
- [ ] One-click setup for Claude Code and Cursor
- [ ] Tests: MCP SDK in-memory client against the fixtures
- [ ] Docs: using RouteLens from Claude Code, Cursor and Copilot agent mode

**Acceptance:** on a fixture with a planted bug, Claude Code and Copilot agent mode can "test my API and fix what's broken": list routes, run them, read the failing route and propose the fix.

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
