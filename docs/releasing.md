# Releasing RouteLens

How a version gets from `main` to the VS Code Marketplace, Open VSX, npm and GitHub Releases. Why it works this way: [ADR-0010](decisions/0010-release-and-distribution.md).

The short version: update the CHANGELOG and the versions, push a tag, approve the release in GitHub Actions, then upload by hand what the workflow skipped.

## One-time setup

Do these once, in this order, before the first tag. Open VSX is finished after the first release (step 3). Every account belongs to Harsh. No token is ever written into a file in this repository.

### 1. The `release` environment (do this first)

GitHub → the repository → **Settings → Environments → New environment** → name it `release`.

- **Name:** exactly `release`, all lowercase. npm and Open VSX check it against the environment you type in their trusted-publisher settings. GitHub can't rename an environment, so if the saved name is wrong (`Release`, for example), delete the environment and create it again.
- **Required reviewers:** add `harshdazz`. This is what makes the publish job wait for your click.
- **Deployment branches and tags:** "Selected branches and tags" → add the tag rule `v*`.

If the environment doesn't exist, GitHub creates it on the first release **without** a reviewer, and the release publishes without asking. So set it up before the first tag.

### 2. VS Code Marketplace

1. Sign in at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) with your Microsoft account and choose **Create publisher**. **ID:** `harshdazz` (it must match `publisher` in `packages/vscode/package.json` and can't be changed later). **Name:** Harsh Dubey.
2. Pick one way to publish:
   - **By hand (no secret):** after each release, download the `.vsix` from the GitHub Release and upload it on the publisher page. The first time, choose **New extension → Visual Studio Code**. For later versions, choose **⋯ → Update** on RouteLens. The workflow reminds you with a warning.
   - **Token (works until 2026-12-01):** in Azure DevOps create a personal access token with **Organization: All accessible organizations** and the scope **Marketplace → Manage**. Save it as the repository secret `VSCE_PAT` (Settings → Secrets and variables → Actions → Secrets). Azure DevOps stops accepting these tokens on 2026-12-01; after that, use the hand upload until publishing moves to Microsoft Entra ID.

### 3. Open VSX (for Cursor, VSCodium and other editors)

Open VSX lets only a namespace **owner** add a trusted publisher, and only for an extension that is already published. Creating the namespace makes you a contributor, not the owner. So, like npm, the first version goes to Open VSX by hand with a token, and trusted publishing is turned on after that.

Before the first release:

1. Sign in at [open-vsx.org](https://open-vsx.org) with GitHub and sign the Eclipse publisher agreement when asked (it needs a free Eclipse account).
2. Create an access token (**Settings → Access Tokens**) and create the namespace once:

   ```bash
   npx ovsx create-namespace harshdazz -p <token>
   ```

   Then delete the token.

3. Leave the repository variable `OVSX_TRUSTED_PUBLISHING` unset. The workflow then skips Open VSX with a warning, and you publish by hand (see [Each release](#each-release)). If the variable is set before the trusted publisher exists, the Open VSX step fails and the job stops before the Marketplace and GitHub Release steps.

After the first version is on Open VSX and on the Marketplace:

4. **Claim the namespace.** This is required, not optional: without it you can't add a trusted publisher. Open a [Claim namespace ownership](https://github.com/EclipseFdn/open-vsx.org/issues/new?template=claim-namespace-ownership.yml) issue for `harshdazz` and choose **Option 1**: the namespace is also a Marketplace publisher, and its extension's `package.json` points at a repository you own. Wait until the Open VSX team approves it.
5. **Settings → Trusted Publishers:** add GitHub Actions with owner `harshdazz`, repository `routelens`, workflow `release.yml`, environment `release`.
6. Only now set the repository variable `OVSX_TRUSTED_PUBLISHING` to `true` (Settings → Secrets and variables → Actions → **Variables**). From the next release on, the workflow publishes to Open VSX.

### 4. npm

1. Create an npm account with two-factor authentication, then an organization called `routelens` (free for public packages). That gives you the `@routelens/` scope.
2. npm only lets a workflow publish a package that already exists, so publish each one by hand once, from the repository:

   ```bash
   pnpm install
   pnpm --filter @routelens/cli --filter @routelens/mcp build
   npm login
   pnpm --filter @routelens/cli publish --access public
   pnpm --filter @routelens/mcp publish --access public
   ```

   `pnpm publish` turns the `workspace:` links into real versions; plain `npm publish` doesn't.

   npm stages a brand-new package: it first shows a public `0.0.0-stage` placeholder version, and the real version goes live a few minutes later. The placeholder stays in the version list. That is expected.

3. On npmjs.com, open each package → **Settings → Trusted publishing → GitHub Actions**: owner `harshdazz`, repository `routelens`, workflow `release.yml`, environment `release`. Under the allowed actions, tick **Allow npm publish** (the workflow runs `npm publish`) and leave **Allow npm dist-tag** unticked. These fields can't be edited after you save, so check them first.
4. Set the repository variable `NPM_TRUSTED_PUBLISHING` to `true`.

## Each release

1. **CHANGELOG:** in `CHANGELOG.md`, change `## X.Y.Z (not released yet)` to `## X.Y.Z (YYYY-MM-DD)` with today's date. That section becomes the GitHub Release text.
2. **Versions:** the extension, the CLI and the MCP server always share one version.

   ```bash
   pnpm --filter routelens --filter @routelens/cli --filter @routelens/mcp exec npm pkg set version=X.Y.Z
   ```

3. **Check and commit:** `pnpm check`, commit as `chore: release vX.Y.Z`, push, and wait for CI to pass.
4. **Tag:**

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Approve:** GitHub → Actions → the **Release** run. After the checks and the packaging, it waits on **Review deployments**. Read the release notes the package job printed, then approve.
6. **Upload by hand** what the run skipped with a warning. Download the `.vsix` from the GitHub Release first.
   - **Marketplace** (no `VSCE_PAT`): on the [publisher page](https://marketplace.visualstudio.com/manage/publishers/harshdazz), the first version goes in with **New extension → Visual Studio Code**, later versions with **⋯ → Update** on RouteLens.
   - **Open VSX** (until `OVSX_TRUSTED_PUBLISHING` is on): create an access token on open-vsx.org (**Settings → Access Tokens**), publish, then delete the token:

     ```bash
     npx ovsx publish routelens-X.Y.Z.vsix -p <token>
     ```

     After the first version, finish the Open VSX setup (steps 4 to 6 above).

7. **Check what was published:**
   - The Marketplace page (it can take a few minutes to appear) and the Open VSX page.
   - `npx @routelens/cli@X.Y.Z --version` and `npx -y @routelens/mcp@X.Y.Z --version`.
   - The GitHub Release, with the `.vsix` and its SHA-256.
   - Install RouteLens from the Marketplace in a clean VS Code profile and click ▶ Send on a project.

If a step fails, fix the cause and choose **Re-run failed jobs**. Every publish step skips what is already published.

The workflow stops before anything is published if a version differs from the tag, or if the CHANGELOG section has no date.

## The demo GIF and screenshots

`docs/images/demo.gif` and the three `demo-*.png` screenshots in the README are recorded by a script that drives a real VS Code with Playwright, on a fresh copy of `fixtures/buggy-api` with the packaged extension. Record them again when the UI they show changes:

```bash
pnpm --filter routelens package
pnpm demo:record
```

It needs port 3456 free, and the internet the first time (VS Code and `npm ci`). The script is `packages/vscode/scripts/demo.mjs`; the captions and timings are at the top.

## The icon

`packages/vscode/media/icon.png` is `media/icon.svg` rendered at 256×256 with headless Chrome:

```bash
chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 --window-size=256,256 --screenshot=icon.png icon.svg
```

The Marketplace refuses SVG icons, so render the PNG again whenever the SVG changes.
