// How each AI agent starts the RouteLens MCP server (ADR-0009). No `vscode` import, so it can
// be unit-tested.

/** The standard MCP server entry: what goes under `mcpServers.routelens` in any agent's config. */
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export const SERVER_NAME = "routelens";

/**
 * Run the server file with `node` when it is installed, else with the editor's own Node.js
 * (`ELECTRON_RUN_AS_NODE=1` makes the editor's executable behave like `node`).
 */
export function mcpServerConfig(
  serverFile: string,
  root: string,
  runtime: { node: string } | { electron: string },
): McpServerConfig {
  const args = [serverFile, "--root", root];
  return "node" in runtime
    ? { command: runtime.node, args }
    : { command: runtime.electron, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** `{ "mcpServers": { "routelens": … } }`: the JSON most agents (and Cursor's mcp.json) read. */
export function mcpJson(config: McpServerConfig): string {
  return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: config } }, null, 2)}\n`;
}

/**
 * The Claude Code command that adds the server for this project only ("local" scope: stored
 * in the person's Claude Code settings, not in the repo). Every value is quoted, so paths with
 * spaces work in PowerShell, cmd and POSIX shells.
 */
export function claudeAddCommand(config: McpServerConfig): string {
  const env = Object.entries(config.env ?? {}).map(
    ([name, value]) => `--env ${quote(`${name}=${value}`)} `,
  );
  return `claude mcp add --scope local ${env.join("")}${SERVER_NAME} -- ${[config.command, ...config.args].map(quote).join(" ")}`;
}

/** Cursor's MCP install link: Cursor shows the server and asks the person to confirm. */
export function cursorInstallLink(config: McpServerConfig): string {
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(encoded)}`;
}

function quote(value: string): string {
  if (value.includes('"'))
    throw new Error(`Cannot put a path with a double quote in a command: ${value}`);
  return `"${value}"`;
}
