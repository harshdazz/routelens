# ADR-0006: Zero setup: find the user's server and start it for them

- Status: Accepted
- Date: 2026-10-21

## Context

Today, before sending a first request, a user has to create `.routelens/`, write an environment file with the right port, start their dev server in a terminal, and write a request file by hand. Each step is a place where people give up. The goal is: install, click ▶ Send, see the answer.

## Decision

1. **Activate in any JavaScript project** (a `package.json` in the workspace), not only when `.req.json` files already exist.
2. **Find the server address with plain code** (`packages/core`, `detect` module), checking clues in this order:
   1. a port that is already open and matches the project
   2. `.env` / `.env.local` `PORT=`
   3. `package.json` scripts (`next dev` → 3000, `-p` / `--port` flags, `vite` → 5173, `nest start` → 3000)
   4. the server code (`app.listen(4000)`, `process.env.PORT || 4000`)
   5. if unclear, ask once with suggestions

   The result is written to `.routelens/environments/local.env.json`, and the user is told which clue was used, with a Change button.

3. **Create `.routelens/` automatically** the first time a request is created or sent.
4. **Check that the server is up before sending**: a short TCP connect to the port, about 300 ms.
5. **Offer to start the server when it is off:**
   - the package manager comes from the lockfile (pnpm, yarn, bun or npm)
   - the script is `dev`, or `start` if there is no `dev`
   - it runs in a visible VS Code terminal named "RouteLens: dev server"
   - RouteLens waits up to 60 seconds with a Cancel button, then sends the request again automatically
   - if the process exits, RouteLens says so and shows the terminal
6. **Show the result inline** next to the Send button (`✓ 201 Created · 14 ms`), with the full panel one click away.

## Why

- Most of the "it just works" feeling comes from removing steps, not from AI. Plain code is instant, free, private and predictable.
- Telling the user where the address came from keeps the automation honest and easy to fix when the guess is wrong.
- A visible terminal keeps the user in control: they see the logs and can stop the server.

## Consequences

- **Starting a server runs the project's own code.** Rules:
  - only in trusted workspaces
  - only the `dev` / `start` scripts from `package.json`, never a command read from a `.routelens` file
  - the first time needs a click
  - the setting `routelens.autoStartServer` (`ask` | `always` | `never`, default `ask`) controls later starts
- Detection rules need fixture projects (Next.js with and without `-p`, Vite, Express with `PORT` in `.env`, a monorepo) and tests in `packages/core`.
- Wrong guesses will happen. They are handled by the Change button, by asking when clues disagree, and by keeping the environment file easy to edit.
- Activating on any `package.json` makes RouteLens start in more workspaces, so activation must stay cheap: no scanning until it is needed.

## Update (2026-10-21, while building M2)

Details decided while building. The decision above still holds.

- **Detection order, refined.** A port written in the script (`next dev -p 3001`, `PORT=3001 node server.js`) beats `.env`, because command-line flags override config files in every dev server we support. A tool's default port (`next dev` → 3000) stays below `.env`. Next.js and Vite choose their port before they read `.env`, so for them `PORT=` in `.env` drops below the default. A server already running on any of these ports still wins. Every distinct port found is offered by the Change button.
- **Monorepos.** With `workspaces` in package.json or a `pnpm-workspace.yaml`, RouteLens picks the package that looks most like an API server (a server framework such as Express or Fastify, then a full-stack framework such as Next.js, then a folder named `api`, `server` or `backend`) and runs its script in that folder. `.routelens/` stays at the workspace root.
- **Package manager:** Corepack's `packageManager` field first, then the lockfile. The search goes up from the package folder, but never above the workspace folder or the Git repository root, so a stray lockfile in the home folder is ignored.
- **The server runs as a VS Code task**, not as text typed into a terminal. A task tells RouteLens when the process exits and with which exit code, so crashes can be reported. On Windows it runs through `cmd.exe`, because PowerShell's default execution policy blocks `npm.ps1`.
- **"The first start needs a click" is per workspace.** RouteLens remembers the click in VS Code's workspace state (not in the repo). `always` only skips the prompt after that, so a cloned repo's `.vscode/settings.json` cannot make RouteLens run code without a click.
- **Automatic setup runs once per folder**: only in trusted workspaces, only with a `package.json`, and only when a clue was found. If the user deletes `.routelens/`, RouteLens does not put it back by itself. A project with a dev script but no port clue gets one "Choose address" message; a library without a `dev`/`start` script gets nothing.
- **A first request** (`.routelens/requests/first-request.req.json`, `GET {{baseUrl}}/`) is created with the environment, so there is something to click before route scanning (M3) exists.
- **The response panel** opens on the first send. If the user closes it, RouteLens stops opening it and the inline result is enough; clicking the inline result brings the panel back.
