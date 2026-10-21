import { execFile } from "node:child_process";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  claudeAddCommand,
  cursorInstallLink,
  mcpJson,
  mcpServerConfig,
  type McpServerConfig,
} from "./agentSetup";

// AI agents use RouteLens through its MCP server (ADR-0009):
// - Copilot agent mode: registered with VS Code, nothing to set up
// - Claude Code and Cursor: "RouteLens: Connect an AI Agent"

export const MCP_PROVIDER_ID = "routelens.mcp";

/** The parts of VS Code's MCP API (1.101+) RouteLens uses. Typed here, so RouteLens still runs (without them) in editors built on older VS Code. */
interface McpApi {
  lm: {
    registerMcpServerDefinitionProvider(
      id: string,
      provider: {
        onDidChangeMcpServerDefinitions?: vscode.Event<void>;
        provideMcpServerDefinitions(
          token: vscode.CancellationToken,
        ): vscode.ProviderResult<unknown[]>;
      },
    ): vscode.Disposable;
  };
  McpStdioServerDefinition: new (
    label: string,
    command: string,
    args?: string[],
    env?: Record<string, string>,
    version?: string,
  ) => { cwd?: vscode.Uri };
}

function mcpApi(): McpApi | undefined {
  const api = vscode as unknown as Partial<McpApi> & { lm?: Partial<McpApi["lm"]> };
  return typeof api.lm?.registerMcpServerDefinitionProvider === "function" &&
    typeof api.McpStdioServerDefinition === "function"
    ? (api as McpApi)
    : undefined;
}

/** True when this editor can give RouteLens's tools to its own agent (VS Code 1.101+). */
export function editorHasMcp(): boolean {
  return mcpApi() !== undefined;
}

/**
 * Copilot agent mode: one RouteLens MCP server per trusted workspace folder, run by the
 * editor's own Node.js, so there is nothing to install or configure.
 */
export function registerMcpServers(context: vscode.ExtensionContext): vscode.Disposable {
  const api = mcpApi();
  if (!api) return new vscode.Disposable(() => undefined);
  const changed = new vscode.EventEmitter<void>();
  const serverFile = context.asAbsolutePath(path.join("dist", "mcp-server.js"));
  const version = String(
    (context.extension.packageJSON as { version?: string }).version ?? "0.0.0",
  );
  return vscode.Disposable.from(
    changed,
    api.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        // The tools send HTTP requests: only in workspaces the person trusts.
        if (!vscode.workspace.isTrusted) return [];
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.map((folder) => {
          const config = mcpServerConfig(serverFile, folder.uri.fsPath, {
            electron: process.execPath,
          });
          const definition = new api.McpStdioServerDefinition(
            folders.length > 1 ? `RouteLens (${folder.name})` : "RouteLens",
            config.command,
            config.args,
            config.env,
            version,
          );
          definition.cwd = folder.uri;
          return definition;
        });
      },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => changed.fire()),
  );
}

/**
 * Copy the server to the extension's global storage, a path that stays the same when the
 * extension updates, so Claude Code and Cursor configs keep working. Copied again when the
 * bundled server changed. Returns the copy's path.
 */
export async function installStableServer(
  context: vscode.ExtensionContext,
  onlyIfPresent = false,
): Promise<string | undefined> {
  const source = context.asAbsolutePath(path.join("dist", "mcp-server.js"));
  const target = path.join(context.globalStorageUri.fsPath, "mcp", "routelens-mcp.cjs");
  const [from, to] = await Promise.all([stat(source), stat(target).catch(() => undefined)]);
  if (!to && onlyIfPresent) return undefined;
  if (!to || to.size !== from.size || to.mtimeMs < from.mtimeMs) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return target;
}

export type AgentChoice = "claude" | "cursor" | "copilot" | "copy";

/** What "Connect an AI Agent" did, for tests and scripts. */
export interface ConnectResult {
  agent: AgentChoice;
  config: McpServerConfig;
  /** The Claude Code command, the Cursor link, or the copied JSON. */
  detail: string;
}

/**
 * "RouteLens: Connect an AI Agent". Claude Code: runs `claude mcp add` in a terminal you can
 * see (or copies it when `claude` is not installed). Cursor: opens its install link, and Cursor
 * asks you to confirm. Copilot: already connected. Or copy the JSON for any other agent.
 */
export async function connectAgentCommand(
  context: vscode.ExtensionContext,
  root: string | undefined,
  choice?: AgentChoice,
): Promise<ConnectResult | undefined> {
  if (!root) return undefined;
  const agent = choice ?? (await pickAgent());
  if (!agent) return undefined;

  const serverFile = await installStableServer(context);
  if (!serverFile) return undefined;
  const node = await onPath("node");
  const config = mcpServerConfig(
    serverFile,
    root,
    node ? { node: "node" } : { electron: process.execPath },
  );

  switch (agent) {
    case "claude": {
      const command = claudeAddCommand(config);
      if (await onPath("claude")) {
        const terminal = vscode.window.createTerminal({
          name: "RouteLens: Claude Code",
          cwd: root,
        });
        terminal.show();
        terminal.sendText(command);
        void vscode.window.showInformationMessage(
          "RouteLens: added to Claude Code for this project. Start `claude` here and ask it to test your API.",
        );
      } else {
        await vscode.env.clipboard.writeText(command);
        void vscode.window.showInformationMessage(
          "RouteLens: Claude Code is not on your PATH. The setup command is copied: run it in your project folder.",
        );
      }
      return { agent, config, detail: command };
    }
    case "cursor": {
      const link = cursorInstallLink(config);
      await vscode.env.openExternal(vscode.Uri.parse(link));
      void vscode.window.showInformationMessage(
        "RouteLens: Cursor asks you to confirm adding the RouteLens MCP server. Then ask its agent to test your API.",
      );
      return { agent, config, detail: link };
    }
    case "copilot":
      void vscode.window.showInformationMessage(
        editorHasMcp()
          ? "RouteLens: Copilot agent mode already has the RouteLens tools. Open Chat, pick Agent, and ask it to test your API."
          : "RouteLens: this editor has no MCP support for extensions (VS Code 1.101 or newer has it). Use Copy MCP Config instead.",
      );
      return { agent, config, detail: "" };
    case "copy": {
      const json = mcpJson(config);
      await vscode.env.clipboard.writeText(json);
      void vscode.window.showInformationMessage(
        "RouteLens: the MCP config is copied. Paste it into your agent's MCP settings.",
      );
      return { agent, config, detail: json };
    }
  }
}

async function pickAgent(): Promise<AgentChoice | undefined> {
  const items: Array<vscode.QuickPickItem & { agent: AgentChoice }> = [
    { label: "Claude Code", description: "adds RouteLens for this project", agent: "claude" },
    { label: "Cursor", description: "opens Cursor's MCP install link", agent: "cursor" },
    {
      label: "Copilot agent mode",
      description: editorHasMcp() ? "already connected in this VS Code" : "needs VS Code 1.101+",
      agent: "copilot",
    },
    { label: "Copy MCP config", description: "for any other agent", agent: "copy" },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "RouteLens: connect an AI agent",
    placeHolder: "Which agent should be able to list, run and debug your API routes?",
  });
  return picked?.agent;
}

/** True when `command` is installed (`where` on Windows, `which` elsewhere). */
function onPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [command], (error) =>
      resolve(!error),
    );
  });
}
