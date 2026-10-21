import { connect } from "node:net";
import * as vscode from "vscode";

/** The shape `routelens.sendRequest` returns (see src/inlineResult.ts). */
export type SendResult =
  | { kind: "response"; view: { response: { status: number } } }
  | { kind: "error"; code: string }
  | undefined;

/** Poll `check` until it returns something other than `undefined`. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "localhost", port, autoSelectFamily: true });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function lensTitles(uri: vscode.Uri): Promise<string[]> {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    "vscode.executeCodeLensProvider",
    uri,
  );
  return lenses.map((lens) => lens.command?.title ?? "");
}

export function routeLensTaskIsRunning(): boolean {
  return vscode.tasks.taskExecutions.some(
    (execution) => execution.task.definition.type === "routelens",
  );
}
