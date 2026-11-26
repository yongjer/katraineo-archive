#!/usr/bin/env node
// End-to-end smoke test of an installed Katraineo on Windows or Linux, through tauri-driver (WebDriver): it starts the
// app with a fresh config, waits for KataGo, plays a move and gets the AI's reply, pastes a game, opens dialogs, and
// finds a (test) update. CI runs it on the installers it built; see "End-to-end tests" in DEVELOPMENT.md.
//
// Environment:
//   KATRAINEO_APP   the app's executable
//   KATAGO          the KataGo for the app to use (CI: KataGo's CPU build, as the runners have no GPU)
//   NATIVE_DRIVER   WebKitWebDriver (Linux) or msedgedriver (Windows); default: on PATH
//   TAURI_DRIVER    tauri-driver; default: on PATH
//   E2E_TLS_DIR     optional: ca.pem, server.pem and server.key, to serve a test update over https. The app must
//                   trust ca.pem: SSL_CERT_FILE does it on Linux (set here), the certificate store on Windows.
//   E2E_OUT         screenshots, the KataGo log and tauri-driver's output (default: e2e-output)
//   XDG_CONFIG_HOME required on Linux, so that the test never overwrites a real config

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keys, Session, sleep, until } from "./webdriver.mjs";

const env = process.env;
const app = env.KATRAINEO_APP;
const katago = env.KATAGO;
const out = env.E2E_OUT ?? "e2e-output";
const PORT = 4444;
const IDENTIFIER = "io.github.yongjer.katraineo";
if (!app || !katago) throw new Error("set KATRAINEO_APP and KATAGO");
mkdirSync(out, { recursive: true });

// ------------------------------------------------------------------ a fresh config pointing at the test KataGo
function configDir() {
  if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), IDENTIFIER);
  if (!env.XDG_CONFIG_HOME) throw new Error("set XDG_CONFIG_HOME to an empty folder, so the test does not touch your config");
  return join(env.XDG_CONFIG_HOME, IDENTIFIER);
}
const configPath = join(configDir(), "config.json");
if (existsSync(configPath) && !env.CI) throw new Error(`${configPath} exists: run the test with a fresh profile`);
mkdirSync(configDir(), { recursive: true });
// few visits: the CPU build of KataGo is slow
writeFileSync(configPath, JSON.stringify({ engine: { katago, max_visits: 30, fast_visits: 8, max_time: 5 } }, null, 2));

// ------------------------------------------------------------------ a test update: newer version, invalid signature
let server = null;
const childEnv = { ...env };
if (env.E2E_TLS_DIR) {
  const tls = (f) => readFileSync(join(env.E2E_TLS_DIR, f));
  server = createServer({ key: tls("server.key"), cert: tls("server.pem") }, (req, res) => {
    if (req.url === "/latest.json") {
      const platform = process.platform === "win32" ? "windows-x86_64" : "linux-x86_64";
      const entry = { url: `https://127.0.0.1:${server.address().port}/payload`, signature: "dGVzdA==" };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ version: "99.0.0", notes: "A test update", platforms: { [platform]: entry } }));
    }
    if (req.url === "/payload") return res.writeHead(200).end(Buffer.alloc(1024));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  childEnv.KATRAINEO_UPDATE_ENDPOINT = `https://127.0.0.1:${server.address().port}/latest.json`;
  if (process.platform !== "win32") childEnv.SSL_CERT_FILE = join(env.E2E_TLS_DIR, "ca.pem");
}

// ------------------------------------------------------------------ tauri-driver
const driverArgs = ["--port", String(PORT)];
if (env.NATIVE_DRIVER) driverArgs.push("--native-driver", env.NATIVE_DRIVER);
const driverLog = createWriteStream(join(out, "tauri-driver.log"));
const driver = spawn(env.TAURI_DRIVER ?? "tauri-driver", driverArgs, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
driver.stdout.pipe(driverLog);
driver.stderr.pipe(driverLog);
await until(async () => (await fetch(`http://127.0.0.1:${PORT}/status`)).ok, { what: "tauri-driver", timeout: 30000 });

// ------------------------------------------------------------------ the test
const results = [];
let s = null;
async function step(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, seconds: (Date.now() - start) / 1000, detail });
    console.log(`ok   ${name}${detail ? `: ${detail}` : ""}`);
  } catch (e) {
    results.push({ step: name, ok: false, seconds: (Date.now() - start) / 1000, error: String(e) });
    console.log(`FAIL ${name}: ${e}`);
    throw e;
  }
}
const shot = async (name) => writeFileSync(join(out, `${name}.png`), await s.screenshot());
const bodyText = () => s.execute("return document.body.innerText");
const infoText = () => s.execute("return document.querySelector('.info-text')?.textContent ?? ''");
const engineState = () => s.execute("return document.querySelector('.engine-dot')?.getAttribute('title') ?? ''");
const closeDialogs = async () => {
  for (let i = 0; i < 3 && (await s.findAll(".modal")).length; i++) await s.press(Keys.Escape);
};

/** Where an intersection is on screen: column and row from the top-left, in the board's own (SVG) units. */
async function intersection(col, row) {
  return s.execute(
    `const svg = document.querySelector('.board-wrap svg');
     const p = svg.createSVGPoint(); p.x = arguments[0]; p.y = arguments[1];
     const q = p.matrixTransform(svg.getScreenCTM()); return [q.x, q.y];`,
    col,
    row,
  );
}

let failed = false;
try {
  await step("start the app", async () => {
    s = await Session.start(`http://127.0.0.1:${PORT}`, app);
    await s.waitFor(".topbar", { timeout: 60000 });
    return await s.execute("return document.title");
  });

  await step("start KataGo", async () => {
    const state = await until(
      async () => {
        const t = await engineState();
        if (/not running|failed|died/i.test(t)) throw new Error(t); // keeps the last error for the timeout message
        return /ready|queries/i.test(t) ? t : null;
      },
      { what: "KataGo", timeout: 180000, interval: 1000 },
    );
    return state;
  });

  await step("play a move, and the AI answers", async () => {
    const [x, y] = await intersection(15, 3); // Q16
    await s.clickAt(x, y);
    // (a fast engine may have answered already)
    await until(async () => /Move [12]\b/.test(await infoText()), { what: "Black's move", timeout: 20000 });
    const info = await until(async () => {
      const t = await infoText();
      return /Move 2\b/.test(t) ? t : null;
    }, { what: "the AI's move", timeout: 180000, interval: 1000 });
    await shot("1-played");
    return info.split("\n")[0];
  });

  await step("paste a game", async () => {
    const sgf = readFileSync(new URL("../tests-ts/data/LS vs AG - G4 - English.sgf", import.meta.url), "utf8");
    await s.execute("return window.__TAURI_INTERNALS__.invoke('plugin:clipboard-manager|write_text', { text: arguments[0] })", sgf);
    await s.press(Keys.Control, "v");
    await until(async () => (await bodyText()).includes("Lee Sedol"), { what: "the game", timeout: 30000 });
    await s.press(Keys.Control, Keys.Left);
    for (let i = 0; i < 78; i++) await s.press(Keys.Right);
    const info = await until(async () => {
      const t = await infoText();
      return /Move 78: W L11/.test(t) ? t : null;
    }, { what: "move 78", timeout: 20000 });
    await sleep(5000); // some analysis for the screenshot
    await shot("2-game");
    return info.split("\n")[0];
  });

  await step("open the settings and the report", async () => {
    await s.press(Keys.F8);
    await s.waitForText(".modal", "KataGo");
    await shot("3-settings");
    await closeDialogs();
    await s.press(Keys.F3);
    await s.waitFor(".modal");
    await closeDialogs();
  });

  if (server) {
    await step("find an update, and refuse it with a bad signature", async () => {
      const notice = await s.waitFor(".update-notice", { timeout: 60000 });
      await notice.click();
      await s.waitForText(".modal .update", "99.0.0");
      await (await s.find(".modal-footer button.primary")).click();
      const error = await s.waitFor(".update-error", { timeout: 60000 });
      await shot("4-update");
      const text = await error.text();
      await closeDialogs();
      return text;
    });
  }
} catch {
  failed = true;
  if (s) await shot("failure").catch(() => {});
} finally {
  if (s) {
    // the KataGo log, from the menu
    try {
      await closeDialogs();
      await (await s.find('button[aria-label="Menu"]')).click();
      await (await s.waitForText(".menu-item", "KataGo log", { timeout: 5000 })).click();
      writeFileSync(join(out, "katago.log"), await (await s.waitFor(".modal-body")).text());
    } catch (e) {
      console.log(`could not save the KataGo log: ${e}`);
    }
    await s.close();
  }
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  driver.kill();
  server?.close();
}
process.exit(failed ? 1 : 0);
