# RouteLens

**The API client that reads your code and tests it for you.**

RouteLens is a VS Code extension for full-stack developers. It finds the API routes in your Next.js or Express project, starts your server, builds and runs the requests by itself, and when something breaks it shows you the line of code that caused it.

> Status: **pre-alpha**. Milestones M1 (core client), M2 (zero setup), M3 (reads your code) and M4 (autopilot) are built; M5 (MCP for AI agents) is next. See the [roadmap](docs/03-roadmap.md).

## Why RouteLens

- **Zero setup**: finds your server address, starts the server if it's off, and shows the result next to the button. _(M2)_
- **Reads your code**: requests are generated from your routes and zod schemas, and stay in sync. _(M3)_
- **Autopilot**: "Test everything" in one click, and re-runs on every save. _(M4)_
- **Works with your AI agent**: Claude Code, Cursor and Copilot can drive RouteLens through MCP. _(M5)_
- **Uses the AI you already have**: Copilot in VS Code, or a local model in Private mode where nothing leaves your machine. _(M7)_
- **Lives in your editor**: a "▶ Send" button above every route handler.
- **Git-native**: requests are plain files in `.routelens/`, reviewed in pull requests like code.
- **AI writes tests once, plain code replays them**: fast, free and reliable in CI.

## What works today

- **Zero setup.** Open a JavaScript project (Next.js, Vite, Express, NestJS or a monorepo). RouteLens finds your API's address from your `dev` script, `.env` or server code, creates `.routelens/` with a first request, and tells you which clue it used: "Found your API at http://localhost:3000 (from "next dev" in package.json) · Change".
- **Starts your server for you.** Click **▶ Send request** while your server is off and RouteLens offers **▶ Start server**. It runs your `dev` (or `start`) script in a visible terminal, waits until the port opens (up to 60 s, with Cancel), and sends the request again. If the server crashes, it tells you and shows the terminal.
- **Reads your code.** RouteLens lists every API route in your Next.js (App Router and `pages/api`) or Express project in a **Routes** sidebar, and puts a **▶ Send** button above each route handler. Each route gets a request file with a sample body made from its zod schema, and the sample passes that schema. When you change a route, its request updates by itself, and anything you edited in the request is kept. It reads your code with the TypeScript parser and never runs it.
- **Test everything.** One click (▶▶ in the Routes view) runs every request and flow, reads first and deletes last, and shows a health board in the sidebar: `12 passed · 2 failed`, with ✓/✗ on each route. Requests for routes that have none are made first.
- **Re-runs on save.** Save a route file and its requests run again, with the new ✓/✗ above the handler in well under 2 seconds. Only requests that already ran are sent again.
- **Checks and flows.** A request passes when its status is below 400, or add an `expect` block (`"status": 400`, `"body": { … }`, `"values": { "body.id": { "type": "number" } }`). A `.flow.json` file runs requests in order and passes values on ("create a post, then read it back"). Plain code replays both; no AI.
- **Logs in by itself.** When a route answers 401, RouteLens finds your login route, asks for your login once, keeps it in your system keychain (never in files) and reuses the token.
- **Same tests in CI.** `routelens run` runs the requests and flows from the command line, with a JUnit report, GitHub annotations and `--start` to start your dev server. See [examples/github-actions/routelens.yml](examples/github-actions/routelens.yml).
- **Inline results.** The answer appears next to the button, like `✓ 201 Created · 14 ms`. Hover for a body preview; click for the full panel (status, time, size, headers, pretty body).
- **Environments.** Pick `local`, `staging` and so on from the status bar, and use `{{variables}}` from `.routelens/environments/*.env.json`.
- Requests are `.routelens/requests/*.req.json` files with autocomplete. **RouteLens: New Request** creates one.
- A **Get Started** walkthrough whose 5 steps tick themselves.

Safety: RouteLens only starts servers in trusted workspaces, only runs the `dev` / `start` script from `package.json`, and the first start in each workspace always needs your click. The `routelens.autoStartServer` setting (`ask`, `always` or `never`) controls the starts after that.

## Try it (development)

Requirements: Node.js 20+, pnpm, VS Code.

```bash
pnpm install
pnpm check          # lint, typecheck, test, build
pnpm demo-server    # starts a local API on http://localhost:4000
```

Then open this folder in VS Code and press **F5**. A new VS Code window opens with the `examples/` folder. Open any file in `examples/.routelens/requests/` and click **▶ Send request**.

To see route scanning, open `fixtures/next-app-routes`, `fixtures/next-pages-api` or `fixtures/express-routes` in the F5 window: the **RouteLens** sidebar lists their routes, and each route handler gets a **▶ Send** button. (These fixtures have no `node_modules`, so their servers can't start; scanning only reads the code.)

To try zero setup, run `npm ci` once in `fixtures/next-default`. Then pick **Run RouteLens on the Next.js fixture** in the Run and Debug view and press **F5**. RouteLens finds the API, creates `.routelens/`, and offers to start `next dev` when you click **▶ Send request**.

In the F5 window, click **Test everything** (▶▶) at the top of the RouteLens sidebar to run every example request and the example flow. `GET /api/me` needs a login: use `demo@routelens.dev` / `demo-password`.

The same from the command line (with the demo server running):

```bash
pnpm --filter @routelens/cli build
ROUTELENS_USERNAME=demo@routelens.dev ROUTELENS_PASSWORD=demo-password node packages/cli/dist/cli.js run examples
```

More tests:

```bash
pnpm test:e2e         # extension tests in a real VS Code (downloads it the first time)
pnpm test:acceptance  # M2 check: fresh Next.js fixture, server off, click Send → 200
```

## Project layout

```
packages/core     editor-independent logic (model, variables, HTTP engine, storage, detect, scanner, runner)
packages/vscode   the VS Code extension
packages/cli      `routelens run` for the terminal and CI
examples/         sample requests, a flow, environments, a demo server and a GitHub Actions workflow
fixtures/         small fake projects for the detection, scanner and acceptance tests
docs/             lifecycle plan, product spec, architecture, roadmap, ADRs
```

## Docs

- [Engineering lifecycle plan](docs/00-lifecycle-plan.md)
- [Product spec](docs/01-product-spec.md)
- [Architecture](docs/02-architecture.md)
- [Roadmap](docs/03-roadmap.md)
- [Architecture decisions](docs/decisions/)

## License

[MIT](LICENSE) © 2026 Harsh Dubey
