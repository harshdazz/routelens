# RouteLens — Engineering Lifecycle Plan

This is how RouteLens goes from idea to a released product. Each phase has a clear output and a **gate**: we only move on when the gate is passed.

| #   | Phase           | Output                                                              | Gate                                              | Status                                                              |
| --- | --------------- | ------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| 0   | Discovery       | Market scan, chosen idea                                            | Clear gap we can fill                             | ✅ Done (2026-10-21)                                                |
| 1   | Requirements    | [Product spec](01-product-spec.md)                                  | MVP scope and non-goals agreed                    | ✅ Done (2026-10-21)                                                |
| 2   | Design          | [Architecture](02-architecture.md), [ADRs](decisions/)              | Every hard-to-reverse choice has an ADR           | ✅ Done (2026-10-21, v2 same day)                                   |
| 3   | Build           | Working software, milestone by milestone ([roadmap](03-roadmap.md)) | Each milestone's acceptance criteria pass         | 🟡 In progress (M0–M5 done, M6 started)                             |
| 4   | Test            | Automated tests + manual test pass                                  | `pnpm check` green, test plan executed            | 🟡 Continuous                                                       |
| 5   | Release         | Marketplace + Open VSX listing, v0.1.0                              | Install from Marketplace works on a clean machine | 🟡 v0.1.1 on the Marketplace and npm (2026-10-23); Open VSX pending |
| 6   | Operate & learn | Issues triaged, feedback, v0.2 plan                                 | 5 real users tried it, feedback logged            | ⬜ Not started                                                      |

---

## Phase 0 — Discovery (done)

- Studied how real Electron apps are structured (Framer, Postman) using REA, then stopped: Postman's Acceptable Use Policy forbids reverse engineering. **Nothing from that scan is used in this product.**
- Market scan (Oct 2026): Postman has a paid, metered AI Agent Mode and a cloud agent that connects to repos. Bruno and Hoppscotch have little or no AI. Apidog markets free AI. Keploy turns recorded traffic into tests.
- **Gap:** no local-first, open-source API client that reads your code and keeps requests in sync with it.

## Phase 1 — Requirements (done)

See [01-product-spec.md](01-product-spec.md): problem, target user, user stories, MVP scope, non-goals and success metrics.

## Phase 2 — Design (done)

See [02-architecture.md](02-architecture.md) and the ADRs:

- [ADR-0001](decisions/0001-vscode-extension.md) — ship as a VS Code extension with an editor-independent core
- [ADR-0002](decisions/0002-pnpm-monorepo.md) — pnpm monorepo, TypeScript, Vitest, esbuild
- [ADR-0003](decisions/0003-request-file-format.md) — requests stored as versioned JSON files in `.routelens/`
- [ADR-0004](decisions/0004-ai-writes-once-replay-deterministic.md) — AI writes tests once, plain code replays them
- [ADR-0005](decisions/0005-ai-uses-what-the-user-has.md) — use the AI the user already has: MCP first, VS Code built-in AI, local AI as Private mode
- [ADR-0006](decisions/0006-zero-setup-detect-and-start-server.md) — zero setup: find the user's server and start it for them

**v2 direction (2026-10-21):** as little manual work as possible. Plain code does everything it can, and AI comes from what the user already has.

## Phase 3 — Build

Work happens in milestones (M0–M8) listed in [03-roadmap.md](03-roadmap.md). Each milestone is a thin vertical slice that works end to end.

**Working loop for every task**

1. Pick the next unchecked task in the roadmap.
2. If the task changes a hard-to-reverse decision, write or update an ADR first.
3. Build it in a small slice: core logic + tests first, then the extension UI.
4. Run `pnpm check`.
5. Try it by hand with F5 against the `examples/` folder.
6. Commit with a conventional message, tick the task in the roadmap.

**Definition of done (every task)**

- [ ] Code is typed (no `any` without a comment explaining why)
- [ ] Tests added or updated; `pnpm check` is green
- [ ] Tried by hand in the Extension Development Host
- [ ] Docs updated (roadmap status, README if user-facing, ADR if a decision changed)
- [ ] Harsh can explain what the code does and why

## Phase 4 — Test strategy

| Layer            | Tool                                                       | What it covers                                          | Runs in CI                                            |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| Unit             | Vitest                                                     | variables, body serialization, file parsing, scanners   | Yes                                                   |
| Integration      | Vitest + local `node:http` server                          | real HTTP sending, timeouts, errors                     | Yes                                                   |
| Extension        | `@vscode/test-electron` (from M2)                          | commands register, CodeLens appears, panel opens        | Yes (xvfb on Linux)                                   |
| Detect fixtures  | Small fake projects in `fixtures/` (from M2)               | server address, package manager and script detection    | Yes                                                   |
| Acceptance       | `pnpm test:acceptance` (from M2)                           | a milestone's acceptance check in a real VS Code        | No (installs Next.js; run before closing a milestone) |
| Scanner fixtures | Sample Next.js + Express projects in `fixtures/` (from M3) | route detection accuracy                                | Yes                                                   |
| MCP              | MCP SDK in-memory client (from M5)                         | tool schemas, results and guard rails                   | Yes                                                   |
| AI behaviour     | Recorded model responses (from M7)                         | agent tool calls and test generation, no live API calls | Yes                                                   |
| AI quality       | Small eval set run by hand (from M7)                       | does the generated test make sense?                     | No (manual, before release)                           |
| Manual           | Test plan checklist in each milestone                      | real-world feel, UX                                     | No                                                    |

Rules: CI never calls a live AI model or the public internet. Tests use local servers and recorded fixtures.

## Phase 5 — Release

- Versioning: SemVer. `0.x` while pre-1.0. Keep a `CHANGELOG.md` from the first release.
- Release plan: v0.1.0 at M6 (zero setup, reads your code, autopilot, MCP), v0.2 adds the built-in AI brain (M7), v0.3 adds the manual essentials (M8).
- Package with `@vscode/vsce`, publish to the VS Code Marketplace (publisher account needed) and Open VSX (for Cursor/VSCodium users). The CLI and the MCP server go to npm as `@routelens/cli` and `@routelens/mcp` ([ADR-0010](decisions/0010-release-and-distribution.md)).
- Release checklist ([Releasing](releasing.md)): changelog date → version bump in the three packages → `pnpm check` → push a `vX.Y.Z` tag → the release workflow runs CI, packages and waits for approval → npm, Open VSX, Marketplace, GitHub Release → install from the Marketplace on a clean VS Code profile.
- Launch assets: README with demo GIF, short landing page (Next.js), LinkedIn launch post.

## Phase 6 — Operate & learn

- GitHub Issues with templates (bug / feature). Triage weekly.
- No telemetry in the MVP. Feedback comes from issues, Marketplace reviews and direct conversations.
- After 5 real users: write a short "what we learned" note and plan v0.2.

---

## Using AI to build RouteLens (the right way)

- Claude Code builds one roadmap task at a time from the spec. Harsh reviews every change before it is committed.
- Harsh owns the architecture decisions (ADRs). AI drafts boilerplate, tests and docs.
- Hard rule: **Harsh must be able to explain every file.** Interviewers will ask about the scanner, the agent tools and the security model.
