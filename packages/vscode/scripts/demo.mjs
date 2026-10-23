// Records the README demo in a real VS Code: the packaged extension (.vsix) on a fresh copy of
// fixtures/buggy-api, driven with Playwright over the DevTools protocol. Writes
// docs/images/demo.gif and three screenshots. Needs the internet once (VS Code, npm ci) and
// port 3456 free.
//
//   pnpm --filter routelens-api-client package && pnpm demo:record
import { execFileSync, execSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import gifenc from "gifenc";
import pngjs from "pngjs";
import { chromium } from "playwright-core";

const { GIFEncoder, applyPalette, quantize } = gifenc;
const { PNG } = pngjs;

const extensionDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(extensionDir, "..", "..");
const imagesDir = path.join(repoRoot, "docs", "images");
const { name, version } = JSON.parse(readFileSync(path.join(extensionDir, "package.json"), "utf8"));
const vsix = path.join(extensionDir, `${name}-${version}.vsix`);

const WIDTH = 1100;
const HEIGHT = 690;
const CAPTION = 56;
const DEBUG_PORT = 9333;
const API_PORT = 3456;

// A clean editor for the recording: no welcome page, no AI chat buttons, no pop-ups while
// typing, and the terminal drawn with the DOM so it renders at the recorded size.
const SETTINGS = {
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.layoutControl.enabled": false,
  "workbench.editor.enablePreview": false,
  "workbench.activity.showAccounts": false,
  "window.commandCenter": false,
  "window.restoreWindows": "none",
  "editor.minimap.enabled": false,
  "editor.fontSize": 15,
  "editor.stickyScroll.enabled": false,
  "editor.autoClosingBrackets": "never",
  "editor.autoClosingQuotes": "never",
  "editor.parameterHints.enabled": false,
  "editor.quickSuggestions": { other: false, comments: false, strings: false },
  "editor.suggestOnTriggerCharacters": false,
  "editor.hover.enabled": false,
  "editor.lightbulb.enabled": "off",
  "editor.occurrencesHighlight": "off",
  "editor.selectionHighlight": false,
  "breadcrumbs.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.ignoreRecommendations": true,
  "security.workspace.trust.enabled": false,
  "chat.disableAIFeatures": true,
  "chat.commandCenter.enabled": false,
  "terminal.integrated.fontSize": 13,
  "terminal.integrated.gpuAcceleration": "off",
};

/** The story. Each step leaves the window ready for its frame. */
const STEPS = [
  {
    caption: "Open your project: RouteLens finds your API and every route. No setup.",
    hold: 3200,
    async run(ui) {
      await ui.toast("Found your API").waitFor({ timeout: 60_000 });
      await ui.clickToastButton("API routes in your code", "Show routes");
      await ui.openFile("todos.js");
      await ui.codeLens("Send").first().waitFor({ timeout: 30_000 });
      await sleep(2500);
    },
  },
  {
    caption: "Click ▶ Send. Server off? RouteLens offers to start it.",
    hold: 2600,
    async run(ui) {
      await ui.command("Notifications: Clear All Notifications");
      await ui.codeLens("Send GET /api/todos").first().click();
      await ui.toast("nothing is running").waitFor({ timeout: 30_000 });
    },
  },
  {
    caption: "The answer shows above the handler, with the full response beside it.",
    hold: 3200,
    screenshot: "demo-send.png",
    async run(ui) {
      await ui.clickToastButton("nothing is running", "Start server");
      await ui.codeLens("200 OK").first().waitFor({ timeout: 60_000 });
      await sleep(1500);
    },
  },
  {
    caption: "▶▶ Test everything runs every route: 5 pass, 1 fails with a 404.",
    hold: 3600,
    screenshot: "demo-test-everything.png",
    async run(ui) {
      await ui.command("View: Close Editors in Other Groups");
      await ui.command("View: Hide Panel");
      await ui.command("RouteLens: Test Everything");
      await ui.routes("passed").waitFor({ timeout: 60_000 });
      await ui.goTo("27");
      await sleep(1500);
    },
  },
  {
    caption: "Connect your AI agent: Copilot, Claude Code and Cursor get RouteLens's tools.",
    hold: 3000,
    screenshot: "demo-ai-agent.png",
    async run(ui) {
      await ui.command("Notifications: Clear All Notifications");
      await ui.command("RouteLens: Connect an AI Agent");
      await ui.page.waitForSelector(".quick-input-list .monaco-list-row");
      await sleep(600);
    },
  },
  {
    caption: "Fix line 24, or let your agent fix it: all 6 routes pass.",
    hold: 4200,
    async run(ui) {
      const { page } = ui;
      await page.keyboard.press("Escape");
      // The planted bug: a number id compared with the string from the URL.
      await ui.goTo("24:49");
      for (let i = 0; i < "req.params.id".length; i++)
        await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.type("Number(req.params.id)", { delay: 30 });
      await page.keyboard.press("Control+S");
      await sleep(3000); // node --watch restarts the server with the fix
      await ui.command("RouteLens: Test Everything");
      await ui.routes("6 passed").waitFor({ timeout: 60_000 });
      await sleep(1500);
    },
  },
];

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => (socket.destroy(), resolve(false)));
  });
}

async function waitForPortClosed(port) {
  for (let i = 0; i < 30 && (await isPortOpen(port)); i++) await sleep(500);
  return !(await isPortOpen(port));
}

/** A fresh todo API (fixtures/buggy-api) whose dev server reloads on save, like next dev. */
function makeProject(root) {
  const project = path.join(root, "todo-api");
  cpSync(path.join(repoRoot, "fixtures", "buggy-api"), project, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|\.routelens)([\\/]|$)/.test(source),
  });
  const packageFile = path.join(project, "package.json");
  const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
  packageJson.scripts.dev = "node --watch src/server.js";
  writeFileSync(packageFile, JSON.stringify(packageJson, null, 2) + "\n");
  execSync("npm ci --no-audit --no-fund", { cwd: project, stdio: "inherit" });
  return project;
}

/** The script behind the `code` command. Newer Windows builds keep resources/ in a commit folder. */
function cliScript(executable) {
  const dir = path.dirname(executable);
  const candidates =
    process.platform === "darwin"
      ? [path.join(dir, "..", "Resources", "app", "out", "cli.js")]
      : [
          path.join(dir, "resources"),
          ...readdirSync(dir).map((name) => path.join(dir, name, "resources")),
        ].map((resources) => path.join(resources, "app", "out", "cli.js"));
  const found = candidates.find((file) => existsSync(file));
  if (!found) throw new Error(`VS Code's cli.js not found next to ${executable}`);
  return found;
}

/** Runs VS Code's own CLI (what `code` runs) without a shell, so paths with spaces just work. */
function installExtension(executable, extensionsDir, userDir) {
  execFileSync(
    executable,
    [
      cliScript(executable),
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userDir,
      "--install-extension",
      vsix,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" },
  );
}

async function launch(executable, project, extensionsDir, userDir) {
  const child = spawn(
    executable,
    [
      project,
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userDir,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-telemetry",
      "--new-window",
      // VS Code's npm extension warns about lockfiles in parent folders of the temp project.
      "--disable-extension",
      "vscode.npm",
      `--remote-debugging-port=${DEBUG_PORT}`,
    ],
    { stdio: "ignore" },
  );
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`)
      .catch(() => undefined);
  }
  if (!browser) throw new Error("could not connect to VS Code");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((p) => p.url().includes("workbench"));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("VS Code opened no window");
  await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
  return { browser, page, child };
}

/** Electron can't resize its window over CDP, so the viewport is emulated and VS Code lays out again. */
async function setSize(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event("resize")));
  await sleep(300);
}

function helpers(page) {
  const quickInput = ".quick-input-widget:not([style*='display: none']) input";
  return {
    page,
    async command(text) {
      await page.keyboard.press("F1");
      await page.waitForSelector(quickInput);
      await page.keyboard.type(text, { delay: 10 });
      await page.waitForSelector(".quick-input-list .monaco-list-row");
      await sleep(300);
      await page.keyboard.press("Enter");
    },
    async openFile(name) {
      await page.keyboard.press("Control+P");
      await page.waitForSelector(quickInput);
      await page.keyboard.type(name, { delay: 10 });
      await sleep(800);
      await page.keyboard.press("Enter");
      await page.waitForSelector(`.tab[aria-label*="${name}"]`);
    },
    async goTo(position) {
      await page.keyboard.press("Control+G");
      await page.waitForSelector(quickInput);
      await page.keyboard.type(position);
      await page.keyboard.press("Enter");
    },
    toast: (text) => page.locator(".notification-toast", { hasText: text }),
    async clickToastButton(toastText, button) {
      const toast = page.locator(".notification-toast", { hasText: toastText });
      await toast.waitFor({ timeout: 30_000 });
      await toast.locator(".monaco-button", { hasText: button }).click();
    },
    codeLens: (text) => page.locator(".codelens-decoration a", { hasText: text }),
    routes: (text) => page.locator(".monaco-list-row", { hasText: text }).first(),
  };
}

/** Draws a frame with its caption bar inside VS Code's own window, so no other browser is needed. */
async function addCaption(page, screenshot, caption, label) {
  await page.evaluate(
    async ({ src, caption, label, width, height, bar }) => {
      /* global document */
      const frame = document.createElement("div");
      frame.id = "routelens-demo-frame";
      frame.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#0f172a";
      const top = document.createElement("div");
      top.style.cssText = `height:${bar}px;display:flex;align-items:center;gap:14px;padding:0 20px;font:600 19px 'Segoe UI',system-ui,sans-serif;color:#f8fafc`;
      const step = document.createElement("span");
      step.style.cssText =
        "background:#f97316;color:#0f172a;border-radius:999px;padding:2px 11px;font-size:15px";
      step.textContent = label;
      const text = document.createElement("span");
      text.textContent = caption;
      top.append(step, text);
      const image = document.createElement("img");
      image.style.cssText = `display:block;width:${width}px;height:${height}px`;
      image.src = src;
      await image.decode();
      frame.append(top, image);
      document.body.append(frame);
    },
    {
      src: `data:image/png;base64,${screenshot.toString("base64")}`,
      caption,
      label,
      width: WIDTH,
      height: HEIGHT,
      bar: CAPTION,
    },
  );
  const framed = await page.screenshot();
  await page.evaluate(() => globalThis.document.getElementById("routelens-demo-frame")?.remove());
  return framed;
}

function writeGif(frames, file) {
  const gif = GIFEncoder();
  for (const { png, hold } of frames) {
    const { data, width, height } = PNG.sync.read(png);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay: hold });
  }
  gif.finish();
  writeFileSync(file, gif.bytes());
}

async function main() {
  if (!existsSync(vsix)) {
    throw new Error(
      `${path.basename(vsix)} is missing: run "pnpm --filter routelens-api-client package" first`,
    );
  }
  if (!(await waitForPortClosed(API_PORT))) throw new Error(`port ${API_PORT} is in use`);

  const root = mkdtempSync(path.join(tmpdir(), "routelens-demo-"));
  const extensionsDir = path.join(root, "extensions");
  const userDir = path.join(root, "user");
  mkdirSync(path.join(userDir, "User"), { recursive: true });
  writeFileSync(path.join(userDir, "User", "settings.json"), JSON.stringify(SETTINGS, null, 2));
  const project = makeProject(root);

  const executable = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_TEST_VERSION ?? "stable",
    cachePath: path.join(extensionDir, ".vscode-test"),
  });
  installExtension(executable, extensionsDir, userDir);

  const { browser, page, child } = await launch(executable, project, extensionsDir, userDir);
  const shots = [];
  try {
    await setSize(page, WIDTH, HEIGHT);
    const ui = helpers(page);
    for (const [index, step] of STEPS.entries()) {
      await step.run(ui);
      await sleep(600);
      shots.push(await page.screenshot());
      console.log(`frame ${index + 1}/${STEPS.length}: ${step.caption}`);
    }
    await page.keyboard.press("Escape");
    await setSize(page, WIDTH, HEIGHT + CAPTION);
    const frames = [];
    for (const [index, step] of STEPS.entries()) {
      const png = await addCaption(
        page,
        shots[index],
        step.caption,
        `${index + 1}/${STEPS.length}`,
      );
      frames.push({ png, hold: step.hold });
    }
    mkdirSync(imagesDir, { recursive: true });
    writeGif(frames, path.join(imagesDir, "demo.gif"));
    for (const [index, step] of STEPS.entries()) {
      if (step.screenshot) writeFileSync(path.join(imagesDir, step.screenshot), shots[index]);
    }
    console.log(
      `wrote docs/images/demo.gif and ${STEPS.filter((s) => s.screenshot).length} screenshots`,
    );
  } finally {
    await browser.close().catch(() => {});
    child.kill();
    // The dev server exits with VS Code; then the temp folder can go.
    await waitForPortClosed(API_PORT);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

await main();
