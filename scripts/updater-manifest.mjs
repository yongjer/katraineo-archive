#!/usr/bin/env node
// Writes latest.json, the manifest the app's updater reads (tauri-plugin-updater), for the signed installers of a
// release. The updater looks for "<os>-<arch>-<installer>" first and then "<os>-<arch>", so a deb or MSI install
// updates from a deb or MSI, and the plain keys point at the AppImage and the NSIS installer.
//
//   node scripts/updater-manifest.mjs <dir with the installers and their .sig files> <version> <download base URL> [notes]

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every platform a release must cover. */
export const REQUIRED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

/** The manifest keys an installer serves, from its file name. */
export function platformsFor(name) {
  if (name.endsWith(".app.tar.gz")) {
    const arch = /_aarch64\.app\.tar\.gz$/.test(name) ? "aarch64" : /_x64\.app\.tar\.gz$/.test(name) ? "x86_64" : null;
    return arch ? [`darwin-${arch}`, `darwin-${arch}-app`] : [];
  }
  if (name.endsWith("-setup.exe")) return ["windows-x86_64", "windows-x86_64-nsis"];
  if (name.endsWith(".msi")) return ["windows-x86_64-msi"];
  if (name.endsWith(".AppImage")) return ["linux-x86_64", "linux-x86_64-appimage"];
  if (name.endsWith(".deb")) return ["linux-x86_64-deb"];
  return [];
}

/** The version a signature (the contents of a .sig file) is bound to, from its signed comment. */
export function signedVersion(signature) {
  const text = Buffer.from(signature.trim(), "base64").toString("utf8");
  const comment = text.split("\n").find((l) => l.startsWith("trusted comment:")) ?? "";
  return /(?:^|\t)version:(\S+)/.exec(comment.slice("trusted comment:".length).trim())?.[1] ?? null;
}

/**
 * @param {{ version: string, notes: string, pubDate: string, baseUrl: string, files: { name: string, signature: string }[] }} release
 */
export function buildManifest({ version, notes, pubDate, baseUrl, files }) {
  /** @type {Record<string, { signature: string, url: string }>} */
  const platforms = {};
  for (const { name, signature } of files) {
    const keys = platformsFor(name);
    if (!keys.length) continue;
    const bound = signedVersion(signature);
    if (bound !== version) throw new Error(`${name} is signed for version ${bound ?? "(none)"}, not ${version}`);
    for (const key of keys) {
      if (platforms[key]) throw new Error(`${key} is served by both ${platforms[key].url} and ${name}`);
      platforms[key] = { signature: signature.trim(), url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}` };
    }
  }
  const missing = REQUIRED_PLATFORMS.filter((p) => !platforms[p]);
  if (missing.length) throw new Error(`no installer for ${missing.join(", ")}`);
  return { version, notes, pub_date: pubDate, platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, version, baseUrl, notes = ""] = process.argv.slice(2);
  if (!dir || !version || !baseUrl) {
    console.error("usage: node scripts/updater-manifest.mjs <dir> <version> <download base URL> [notes]");
    process.exit(2);
  }
  const names = readdirSync(dir);
  const files = names
    .filter((n) => platformsFor(n).length && names.includes(`${n}.sig`))
    .map((name) => ({ name, signature: readFileSync(join(dir, `${name}.sig`), "utf8") }));
  const manifest = buildManifest({ version, notes, pubDate: new Date().toISOString(), baseUrl, files });
  writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(Object.keys(manifest.platforms).sort().join("\n"));
}
