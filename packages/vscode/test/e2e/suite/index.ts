import path from "node:path";
import Mocha from "mocha";

/** Entry point VS Code calls inside the extension host (see runTest.mjs). */
export function run(): Promise<void> {
  // "extension" (default, runs in CI) or "acceptance" (the M2 Next.js check, run by hand).
  const suite = process.env.ROUTELENS_E2E_SUITE ?? "extension";
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 180_000 });
  mocha.addFile(path.join(__dirname, `${suite}.e2e.js`));
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures > 0 ? reject(new Error(`${failures} extension test(s) failed.`)) : resolve(),
    );
  });
}
