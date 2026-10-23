import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// Release notes for a version tag (ADR-0010). Checks that the extension, the CLI and the MCP
// server all have the tag's version and that CHANGELOG.md has a dated section for it, then
// prints that section with the install steps and the .vsix's SHA-256.
// Usage: node scripts/release-notes.mjs v0.1.0 release/routelens-0.1.0.vsix

const [tag = "", vsixPath] = process.argv.slice(2);

function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
if (!version) fail(`expected a tag like v0.1.0, got "${tag}"`);
if (!vsixPath) fail("expected the path of the .vsix after the tag");

for (const folder of ["vscode", "cli", "mcp"]) {
  const file = new URL(`../packages/${folder}/package.json`, import.meta.url);
  const packageVersion = JSON.parse(readFileSync(file, "utf8")).version;
  if (packageVersion !== version) {
    fail(`packages/${folder} has version ${packageVersion}, but the tag is ${tag}`);
  }
}

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const section = changelog
  .split(/^## /m)
  .slice(1)
  .find((text) => text.startsWith(`${version} `));
if (!section) fail(`CHANGELOG.md has no "## ${version} (YYYY-MM-DD)" section`);
const [heading = "", ...body] = section.trimEnd().split("\n");
if (!/\(\d{4}-\d{2}-\d{2}\)$/.test(heading)) {
  fail(`give the CHANGELOG section a release date: "## ${version} (YYYY-MM-DD)"`);
}

const vsix = path.basename(vsixPath);
const sha256 = createHash("sha256").update(readFileSync(vsixPath)).digest("hex");

process.stdout.write(`${body.join("\n").trim()}

## Install

Search for **RouteLens API Client** by harshdazz in the VS Code Extensions view. Or download \`${vsix}\` below, open the Extensions view's **\`...\`** menu and choose **Install from VSIX...**. You need VS Code 1.95 or newer.

The CLI and the MCP server are on npm: \`npx @routelens/cli run\` and \`npx -y @routelens/mcp\`.

## Check the download

SHA-256 of \`${vsix}\`:

\`\`\`
${sha256}
\`\`\`
`);
