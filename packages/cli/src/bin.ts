import { main } from "./cli.js";

// The `routelens` command. Everything else is in cli.ts, so tests can run it in-process.
process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
});
