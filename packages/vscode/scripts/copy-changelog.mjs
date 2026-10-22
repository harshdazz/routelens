import { copyFileSync } from "node:fs";

// vsce only packages files from the extension's own folder, so the project's CHANGELOG.md is
// copied here before packaging (ADR-0010). Git ignores the copy.
copyFileSync(
  new URL("../../../CHANGELOG.md", import.meta.url),
  new URL("../CHANGELOG.md", import.meta.url),
);
