# RouteLens — Product Spec (MVP)

_Status: agreed · 2026-10-21 · v2: zero setup, autopilot and AI strategy ([ADR-0005](decisions/0005-ai-uses-what-the-user-has.md), [ADR-0006](decisions/0006-zero-setup-detect-and-start-server.md))_

## One-line pitch

**The API client that reads your code and tests it for you.** RouteLens finds the API routes in your Next.js or Express project, starts your server, builds and runs the requests by itself, and when something breaks it shows you the line of code that caused it. It works with the AI you already use.

## Product principle

**As little human work as possible.** Plain code does everything it can: it's instant, free, private and predictable. AI is used only for steps that need judgement, and it comes from what the user already has.

## Problem

Full-stack developers test their own APIs all day, and the tools make them do it by hand:

1. **Setup gets in the way**: start the server, find the port and write requests before testing anything.
2. **Requests are written by hand** and drift out of date as soon as a route or schema changes.
3. **Tests are tedious** to write, so most small projects have none.
4. **When a request fails**, you switch between the API client, the terminal and the code to find out why.
5. **AI help in existing tools is cloud-only and metered**, and it ignores the AI agent the developer already uses.

## Target user

Primary: a full-stack JavaScript/TypeScript developer building a **Next.js or Express** API, working in VS Code (or Cursor), often with an AI agent such as Claude Code, Cursor or Copilot. Solo or in a small team.

Not for (MVP): enterprise API governance, non-JS backends, teams that need cloud workspaces.

## Differentiators

|                          | RouteLens                                                                                              | Typical API client                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Setup                    | None: finds your server address and starts the server for you                                          | Type URLs, start the server yourself |
| Where requests come from | Generated from your code, kept in sync                                                                 | Typed by hand                        |
| Testing                  | Runs itself: "test everything" and re-run on save                                                      | Click send, one by one               |
| Where it lives           | Inside VS Code, next to the route                                                                      | Separate app                         |
| Where data is stored     | Plain files in your Git repo                                                                           | Cloud workspace                      |
| AI                       | Uses the AI you already have (your agent via MCP, Copilot in VS Code) or a local model in Private mode | Vendor cloud, metered                |
| Tests                    | AI writes them once, plain code replays them (free, fast, works in CI)                                 | Hand-written, or AI on every run     |

## User stories (MVP)

**Core client** (done)

- US-1: As a developer, I can create a request (method, URL, headers, body) and save it as a file in my repo.
- US-2: I can send a request and see status, time, size, headers and a pretty-printed body.
- US-3: I can use variables like `{{baseUrl}}` from an environment file, and I'm warned about missing ones.

**Zero setup**

- US-4: RouteLens finds my server address by itself and tells me where it found it, so I can fix a wrong guess in one click.
- US-5: If my server is off, RouteLens offers to start it, waits until it's ready and sends the request again.
- US-6: I see the result right next to the Send button, without opening a panel.

**Reads your code**

- US-7: RouteLens scans my project and lists every API route (Next.js App Router, Pages API, Express).
- US-8: A "▶ Send" button appears above each route handler in my code.
- US-9: If the route validates its body with zod, the request gets a valid sample body automatically.
- US-10: When my code changes, the matching requests update themselves.

**Autopilot**

- US-11: One click runs every route and shows a health board of what passes and what fails.
- US-12: When I save a route file, its requests re-run and the result updates inline.
- US-13: For protected routes, RouteLens logs in once and reuses the token.
- US-14: I can run all saved tests from the command line (`npx routelens run`) and in GitHub Actions.

**Works with your AI agent**

- US-15: My AI agent (Claude Code, Cursor, Copilot agent mode) can list routes, run requests and read failures through the RouteLens MCP server, with no setup in VS Code and one click elsewhere.

**Built-in AI** (v0.2)

- US-16: RouteLens uses the AI I already have; with Copilot, I need no API key.
- US-17: I can describe a scenario in English ("sign up, log in, create a post, check the feed") and get a saved, replayable test flow.
- US-18: When a request fails, I can click "Explain" and get the likely cause, the related code and a suggested fix.
- US-19: In Private mode, only a local model is used and nothing leaves my machine.

**Essentials** (v0.3)

- US-20: When I want to work by hand, I have a form editor, file upload, history, cURL copy/paste and cookies.

## Non-goals (MVP)

- Cloud sync, team workspaces, accounts or billing
- Running our own AI servers or charging for AI
- AI on every test run (replays are always plain code)
- GraphQL, gRPC, WebSockets (later)
- Backends other than Next.js and Express (later: Fastify, Hono, NestJS)
- Load testing, API documentation hosting
- Telemetry

## Success metrics

| Metric                                                             | Target for v0.1                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| Time from install to first successful request on a Next.js project | under 1 minute, no typed commands, no hand-written files |
| Routes detected correctly on the fixture projects                  | 95%+                                                     |
| Detected routes run by one "Test everything" click                 | 100%                                                     |
| AI agent fixes a planted bug through MCP on a fixture              | works with Claude Code and Copilot agent mode            |
| Generated test flows that pass on the first run (v0.2 eval set)    | 70%+                                                     |
| Real users who tried it and gave feedback                          | 5                                                        |
| Portfolio: README with demo GIF, Marketplace listing, launch post  | done                                                     |

## Risks

| Risk                                                       | Impact           | Mitigation                                                                                       |
| ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| Wrong guess for the server address                         | First send fails | Show the clue used with a Change button; ask when clues disagree; fixtures for each pattern      |
| Starting the server runs project code                      | Security         | Trusted workspaces only, `dev`/`start` scripts only, first start needs a click, visible terminal |
| An AI agent sends harmful requests through MCP             | Data loss        | Only hosts from environment files by default; non-local writes and deletes need confirmation     |
| Local models are slow on normal laptops                    | Bad first try    | Local AI is opt-in (Private mode), not the default; everything without AI still works            |
| Route detection misses patterns (dynamic routes, wrappers) | Users lose trust | Start with common patterns, show "unknown" honestly, fixtures for each pattern                   |
| AI generates wrong tests                                   | Flaky tests      | Tests are saved as plain steps the user reviews; replay never uses AI                            |
| Scope creep                                                | Never ships      | Strict milestones, non-goals list, stretch goals parked                                          |
| Big players ship the same thing                            | Less novelty     | Portfolio value is in execution; local-first, zero setup and open source stay differentiators    |
