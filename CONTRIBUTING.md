# Contributing to RouteLens

Thanks for your interest! RouteLens is an early version (v0.1), so the best help right now is trying it on a real Next.js or Express project and [opening an issue](https://github.com/harshdazz/routelens/issues) about what worked, what didn't, and which route patterns it missed.

## Set up

Requirements: Node.js 20+, [pnpm](https://pnpm.io) 10, VS Code.

```bash
pnpm install
pnpm check          # format, lint, typecheck, tests, build: run it before every commit
```

Useful commands:

| Command                    | What it does                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm test`                | Unit and integration tests (Vitest)                                                         |
| `pnpm test:e2e`            | Extension tests in a real VS Code (downloads it the first time; on Linux use `xvfb-run -a`) |
| `pnpm test:acceptance`     | Zero-setup check on a fresh copy of `fixtures/next-default` (needs port 3000)               |
| `pnpm test:acceptance:mcp` | The AI-agent steps on a fresh copy of `fixtures/buggy-api` (needs port 3456)                |
| `pnpm demo-server`         | A small API on http://localhost:4000 for trying requests                                    |

Press **F5** in VS Code ("Run RouteLens Extension") to open a development window with the `examples/` folder.

## How the code is organised

- `packages/core`: everything that doesn't need VS Code (request model, HTTP engine, detection, route scanner, runner). **It must never import `vscode`.**
- `packages/vscode`: the extension, a thin layer over core.
- `packages/cli` and `packages/mcp`: the CLI and the MCP server, also thin layers over core.

The reasons behind the design are in [docs/02-architecture.md](docs/02-architecture.md) and the [decision records](docs/decisions/).

## Rules

- **Tests:** every change to `packages/core` comes with tests. A new route pattern for the scanner gets a fixture in `fixtures/`.
- **TypeScript strict** everywhere; every file read from disk is validated with zod.
- **Never run user code** while scanning; never read outside the workspace folder.
- **No secrets in `.routelens/` files**: they are committed to Git.
- **Webviews:** strict Content-Security-Policy with a nonce, and every value escaped.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- **Hard-to-reverse decisions** get a short ADR in `docs/decisions/`.
- **Original work only:** never copy code, UI or assets from proprietary products. Code from open-source projects must have a compatible license, with its notice kept.

## Pull requests

1. Fork, and create a branch from `main`.
2. Make the change, with tests.
3. Run `pnpm check` (and `pnpm test:e2e` if you changed the extension).
4. Open the pull request. Say what changed, why, and how you tested it.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
