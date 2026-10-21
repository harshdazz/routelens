import { describe, expect, it } from "vitest";
import { claudeAddCommand, cursorInstallLink, mcpJson, mcpServerConfig } from "../src/agentSetup";

const server =
  "C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\globalStorage\\harshdazz.routelens\\mcp\\routelens-mcp.cjs";
const root = "C:\\Users\\Ada\\My Projects\\todo api";

describe("agent setup", () => {
  it("runs the server with node, or with the editor's own Node.js", () => {
    expect(mcpServerConfig(server, root, { node: "node" })).toEqual({
      command: "node",
      args: [server, "--root", root],
    });
    expect(mcpServerConfig(server, root, { electron: "C:\\VS Code\\Code.exe" })).toEqual({
      command: "C:\\VS Code\\Code.exe",
      args: [server, "--root", root],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("writes the Claude Code command with every path quoted, for this project only", () => {
    expect(claudeAddCommand(mcpServerConfig(server, root, { node: "node" }))).toBe(
      `claude mcp add --scope local routelens -- "node" "${server}" "--root" "${root}"`,
    );
    expect(
      claudeAddCommand(mcpServerConfig(server, root, { electron: "C:\\VS Code\\Code.exe" })),
    ).toBe(
      `claude mcp add --scope local --env "ELECTRON_RUN_AS_NODE=1" routelens -- "C:\\VS Code\\Code.exe" "${server}" "--root" "${root}"`,
    );
    expect(() => claudeAddCommand(mcpServerConfig(server, 'C:\\a"b', { node: "node" }))).toThrow(
      /double quote/,
    );
  });

  it("encodes the config in Cursor's install link", () => {
    const config = mcpServerConfig(server, root, { node: "node" });
    const link = new URL(cursorInstallLink(config));
    expect(`${link.protocol}//${link.host}${link.pathname}`).toBe(
      "cursor://anysphere.cursor-deeplink/mcp/install",
    );
    expect(link.searchParams.get("name")).toBe("routelens");
    expect(
      JSON.parse(Buffer.from(link.searchParams.get("config") ?? "", "base64").toString("utf8")),
    ).toEqual(config);
  });

  it("gives other agents the standard mcpServers JSON", () => {
    expect(JSON.parse(mcpJson({ command: "node", args: ["x"] }))).toEqual({
      mcpServers: { routelens: { command: "node", args: ["x"] } },
    });
  });
});
