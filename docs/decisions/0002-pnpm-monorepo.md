# ADR-0002: pnpm monorepo with TypeScript, Vitest and esbuild

- Status: Accepted
- Date: 2026-10-21

## Context

We will have several packages that share code: `core`, `vscode` (extension), and later `cli` and `mcp`.

## Decision

- **pnpm workspaces** for the monorepo.
- **TypeScript strict** everywhere.
- **Vitest** for tests.
- **esbuild** to bundle the extension into one file.
- Packages point to each other's TypeScript source during development through a `source` export condition, so there is no "build core first" step.

## Why

- pnpm is fast and strict: a package can only import what it declares, which catches mistakes early.
- One `pnpm check` command runs lint, typecheck, tests and build for everything.
- esbuild bundles the extension and its dependencies into a single small file, which is what the Marketplace expects.
- Vitest runs TypeScript directly, so tests are fast to write and run.

## Consequences

- Contributors need pnpm (`corepack enable` or `npm i -g pnpm`).
- The `source` export condition must be configured in esbuild (`conditions`) and TypeScript (`customConditions`) for consumers of core.
