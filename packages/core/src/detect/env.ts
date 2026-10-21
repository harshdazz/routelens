import path from "node:path";
import { parseEnv } from "node:util";
import { readTextIfExists } from "./packageJson.js";
import { toPort } from "./scripts.js";

/** Checked in this order: `.env.local` overrides `.env` in Next.js, Vite and dotenv-flow. */
export const ENV_FILES = [".env.local", ".env"] as const;

/** The first `PORT=` found in the project's `.env` files, with the file it came from. */
export async function readEnvPort(
  dir: string,
): Promise<{ file: (typeof ENV_FILES)[number]; port: number } | undefined> {
  for (const file of ENV_FILES) {
    const text = await readTextIfExists(path.join(dir, file));
    if (text === undefined) continue;
    // Node's own .env parser (the same one behind `node --env-file`).
    const port = toPort(parseEnv(text).PORT);
    if (port !== undefined) return { file, port };
  }
  return undefined;
}
