# ADR-0010: Release and distribution (v0.1)

- Status: Accepted
- Date: 2026-10-22

## Context

M6 is the first public launch. A v0.0.1 pre-release with the `.vsix` is already on GitHub Releases. For v0.1 these had to be decided:

1. The name, because "RouteLens" is already used by other projects.
2. Where RouteLens is published, and under which names.
3. How versions work across the extension, the CLI and the MCP server.
4. How a release gets published, safely and without long-lived secrets where possible.
5. What the `.vsix` must contain to be accepted by the Marketplace.

What was found on 2026-10-22:

- **VS Code Marketplace:** `DharanishAM.routelens`, display name "RouteLens", "Discover all Express/Fastify endpoints visually" (published 2025-10-06, 56 installs, last update 2025-10-07). Also `MariaMonteiro.routelens-rest-api-navigator`, "RouteLens API Route Navigator" (5 installs).
- **npm:** the unscoped name `routelens` belongs to another project (route discovery, first published 2026-10-17). The `@routelens` scope is free.
- **GitHub:** about 30 repositories are called RouteLens.
- **Open VSX:** no RouteLens. No `harshdazz` namespace yet.
- **Marketplace rules:** `vsce` refuses an SVG icon and SVG images in the README and CHANGELOG (except badges from trusted providers). Global Azure DevOps personal access tokens (PATs) stop working on 2026-12-01. The replacement is Microsoft Entra ID (`vsce publish --azure-credential`), which needs an Azure managed identity.
- **npm trusted publishing** (GitHub Actions signs in with OIDC, no token) can only be set up for a package that already exists. The first publish of each package is done by hand.
- **Open VSX** has trusted publishing too (`ovsx publish --trusted-publishing`, ovsx 1.3.0). Creating the namespace still needs an access token once.

## Decision

**Keep the name RouteLens** (Harsh, 2026-10-22). The extension ID `harshdazz.routelens` is unique because it includes the publisher. The Marketplace description says what RouteLens does differently (it writes and runs the requests, and AI agents can use it), so the two listings are easy to tell apart. If the Marketplace refuses the display name, the fallback is "RouteLens API Client".

**Channels:**

| What                            | Where                         | Name                                            |
| ------------------------------- | ----------------------------- | ----------------------------------------------- |
| VS Code extension               | VS Code Marketplace           | `harshdazz.routelens`                           |
| The same `.vsix` (Cursor, etc.) | Open VSX                      | `harshdazz.routelens`                           |
| CLI                             | npm                           | `@routelens/cli` (command `routelens`)          |
| MCP server                      | npm                           | `@routelens/mcp` (command `routelens-mcp`)      |
| Everything above                | GitHub Releases, tag `vX.Y.Z` | `.vsix` attached, with its SHA-256 in the notes |

`@routelens/core` stays private. The CLI, the MCP server and the extension bundle it.

**One version for everything.** The extension, the CLI and the MCP server always have the same version, and the tag is `v` + that version. The release workflow stops if they differ. v0.1.0 is a normal release. RouteLens does not use the Marketplace's pre-release channel yet. If it ever does, pre-releases get odd minor versions (0.3.x), because the Marketplace does not support `-beta` style versions.

**Release workflow** (`.github/workflows/release.yml`), started by pushing a `v*` tag:

1. **CI:** the CI workflow itself (`workflow_call`), on the tagged commit: `pnpm check`, the CLI against the demo server, the extension tests in VS Code.
2. **Package job:** the `.vsix`, the two npm packages and the release notes (`scripts/release-notes.mjs`). It stops if a package's version differs from the tag or the CHANGELOG section has no date.
3. **Publish job:** runs in the GitHub environment `release`, which needs Harsh's approval. Nothing public happens without his click.
   - npm with trusted publishing and provenance. No npm token is stored.
   - Open VSX with trusted publishing. No Open VSX token is stored.
   - Marketplace with the `VSCE_PAT` secret while PATs still work. Without it, the step is skipped with a warning, and the `.vsix` is uploaded by hand on the Marketplace's publisher page.
   - Last, the GitHub Release with the `.vsix` and its SHA-256, so the release page appears once the packages are out.
   - npm and Open VSX are switched on by the repository variables `NPM_TRUSTED_PUBLISHING` and `OVSX_TRUSTED_PUBLISHING`. A channel that isn't set up is skipped with a warning, so one missing account doesn't block the others.
   - Every step skips what is already published, so a failed run can simply be re-run.

**The `.vsix`:**

- `vscode:prepublish` runs the build, so `vsce package` always packages fresh code. The v0.0.1 rebuild showed why: a `.vsix` built before two fixes was nearly published.
- A PNG icon (rendered from `media/icon.svg`), Marketplace metadata (`preview`, gallery banner, categories, keywords), and the project's `CHANGELOG.md`.
- No SVG images in the extension README.

## Why

- **Keeping the name:** it is Harsh's call. The repository, the v0.0.1 pre-release and the docs already use it, and the extension ID can't clash. The cost is that searches for "RouteLens" also show other projects.
- **The `@routelens` scope:** the unscoped name is taken, and a scope keeps the CLI and the MCP server together under one name.
- **One version:** the three parts are released together and tested together, and one number is easier to explain in an issue.
- **An approval step:** a release is public and can't really be taken back. GitHub environments make the approval part of the workflow instead of a habit.
- **Trusted publishing for npm and Open VSX:** no long-lived token to leak, and every npm package gets a provenance statement linking it to this repository and workflow.
- **Marketplace by token or by hand for now:** Entra ID publishing needs an Azure subscription and a managed identity. That is worth doing, but not before the first launch. The hand upload needs no secret at all.
- **Building in `vscode:prepublish`:** packaging must never depend on remembering to build first.

## Consequences

- Before the first release Harsh creates: the `release` environment with himself as reviewer, the Marketplace publisher `harshdazz`, an Open VSX account and the `harshdazz` namespace, and the npm organization `routelens`. Then he publishes each npm package once by hand and turns on trusted publishing for npm and Open VSX. [Releasing](../releasing.md) lists the steps.
- If the `release` environment doesn't exist, GitHub creates it without a reviewer on the first tag. So the environment comes first in the setup.
- After 2026-12-01 the Marketplace step needs Entra ID (`azure/login` with OIDC, then `vsce publish --azure-credential`), or the hand upload. That is a follow-up.
- The `.vsix` still contains TypeScript twice (`extension.js` and `mcp-server.js`, about 4 MB each before compression; the `.vsix` is 2.4 MB). Sharing one copy would mean copying two files to global storage for Claude Code and Cursor. That is not worth the risk for v0.1. It is revisited if the size becomes a problem.
- The CHANGELOG is written by hand, one section per version, in plain English.
