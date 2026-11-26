#!/usr/bin/env node
// Set the version of the app everywhere it is recorded: package.json (tauri.conf.json reads it from there),
// package-lock.json, src-tauri/Cargo.toml and Cargo.lock, and the MSI version in tauri.conf.json, which Windows
// Installer needs as plain numbers. tests-ts/version.test.ts checks that they agree.
//
//   node scripts/set-version.mjs 2.0.0-alpha.2

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The MSI version for an app version: Windows Installer takes only numbers, so a pre-release keeps its release's. */
export function msiVersion(version) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`not a version: ${version}`);
  const [major, minor, patch] = m.slice(1, 4).map(Number);
  if (major > 255 || minor > 255 || patch > 65535) throw new Error(`${version} is too large for an MSI version`);
  return `${major}.${minor}.${patch}`;
}

/** Replace exactly one match of `pattern` (whose first group is the old version). */
function replaceOnce(text, pattern, version, path) {
  const matches = [...text.matchAll(new RegExp(pattern, "gm"))];
  if (matches.length !== 1) throw new Error(`${path}: expected one version line, found ${matches.length}`);
  return text.replace(new RegExp(pattern, "m"), (all, old) => all.replace(old, version));
}

function setVersion(root, version) {
  const msi = msiVersion(version);
  const json = (change) => (text) => {
    const data = JSON.parse(text);
    change(data);
    return JSON.stringify(data, null, 2) + "\n";
  };
  /** @type {[string, (text: string) => string][]} */
  const changes = [
    ["package.json", json((p) => void (p.version = version))],
    ["package-lock.json", json((p) => void (p.version = p.packages[""].version = version))],
    ["src-tauri/tauri.conf.json", json((c) => void (c.bundle.windows.wix.version = msi))],
    ["src-tauri/Cargo.toml", (t) => replaceOnce(t, '^version = "([^"]+)"$', version, "Cargo.toml")],
    ["src-tauri/Cargo.lock", (t) => replaceOnce(t, '^name = "katraineo"\\nversion = "([^"]+)"$', version, "Cargo.lock")],
  ];
  // work out every file before writing any, so that an error leaves them all as they were
  const results = changes.map(([path, change]) => [join(root, path), change(readFileSync(join(root, path), "utf8"))]);
  for (const [path, text] of results) writeFileSync(path, text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version || !SEMVER.test(version)) {
    console.error("usage: node scripts/set-version.mjs <version>, e.g. 2.0.0-alpha.2");
    process.exit(2);
  }
  setVersion(join(dirname(fileURLToPath(import.meta.url)), ".."), version);
  console.log(`Version ${version} (MSI ${msiVersion(version)})`);
}
