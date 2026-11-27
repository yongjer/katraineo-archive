#!/usr/bin/env node
// Downloads the bundled KataGo binaries (Linux, Windows) and default neural network model with SHA-256 verification.
// Kept out of Git so clones and CI checkouts stay small; macOS KataGo is built by scripts/build-katago-macos.sh.
//
//   node scripts/fetch-resources.mjs [--platform linux|windows|macos|all] [--model-only] [--check]

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const KATAGO_VERSION = "v1.18.1";

/**
 * Pinned resource entries. Every download is checked against its archive/file SHA-256, and every extracted file
 * is checked against its individual SHA-256 so cached resources are skipped when already intact.
 */
export const RESOURCES = {
  model: {
    kind: "file",
    url: "https://github.com/lightvector/KataGo/releases/download/v1.17.1/b10c384h6nbttflrs.bin.gz",
    sha256: "0ba27eced5180b3e3d0b898b280c541112989765e789d1eb6cd0d31b2b2c1229",
    dest: "resources/models/b10c384h6nbttflrs.bin.gz",
  },
  linux: {
    kind: "zip",
    url: `https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/katago-${KATAGO_VERSION}-opencl-linux-x64.zip`,
    archiveSha256: "81ecea81526adb412a392ec728dbdf9627e754df7cf1a7a3dbb8ef220182184a",
    destDir: "resources/KataGo",
    files: {
      katago: {
        sha256: "f9029dcaa28608e9efa4e1d404940e651bd067bdd11528222e068f3b34450fd7",
        executable: true,
      },
    },
  },
  windows: {
    kind: "zip",
    url: `https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/katago-${KATAGO_VERSION}-opencl-windows-x64.zip`,
    archiveSha256: "1710db1903ab921aa6837a9599c8474f8a59f057650217c5d9bc125ee393a9ff",
    destDir: "resources/KataGo",
    files: {
      "katago.exe": { sha256: "0e6cc918840e6ef67c0b4a21109585306df7aaa3772971574e58deb8e8fc0575" },
      "cacert.pem": { sha256: "2782f0f8e89c786f40240fc1916677be660fb8d8e25dede50c9f6f7b0c2c2178" },
      "bz2.dll": { sha256: "ce4a0c4b2e8d4409efb9e882df0adeba4a7332ab5194483aff50a28efee27897" },
      "libcrypto-3-x64.dll": { sha256: "1c2152bcb085a7a85b1e81a0a8cb8c353a4c02fe4bb3b46c5e8b75903b2d0cfd" },
      "libssl-3-x64.dll": { sha256: "d29823911faf71b9d71aa7be306887a6d090dc11dff48e1d432ece66ad534229" },
      "msvcp140.dll": { sha256: "7c26614e1d733892c2deac7e245ce115504b1d80592dd0a01b08e3e5a55f89ca" },
      "msvcp140_1.dll": { sha256: "206c931bf90fdad8816de3b5e2ef80b2bcaa9406c89ecc05fe6fddffe251e982" },
      "msvcp140_2.dll": { sha256: "d50d7883f20d1dc6191768d3746f52dd9cac89c346ffaed5be1f110c2f34a838" },
      "msvcp140_atomic_wait.dll": { sha256: "3d0cbfaa1bf3eecf5a3f4491d2960ee803cb994f30292c6adc4a07c498f60e2b" },
      "msvcp140_codecvt_ids.dll": { sha256: "8a65c7596ef2e6938731f5a1058e7e40145b6d97967cc649231a076b9a608d78" },
      "vcruntime140.dll": { sha256: "d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7" },
      "vcruntime140_1.dll": { sha256: "a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e" },
      "vcruntime140_threads.dll": { sha256: "40f39e8cee5f5a531b4010e18b807e8fe265b908dc58f959ecb7ebc6ea6cb11a" },
      "z.dll": { sha256: "a07ca94d3843a64b8b916ed83899ad9029578f1a931ec088d81da82834459e0c" },
      "zip.dll": { sha256: "0d88c137ddfaf3a506672cdc8da35658a1ea15fb5fd9d91950cb0658266e600e" },
    },
  },
};

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} [platform] */
export function normalizePlatform(platform = process.platform) {
  if (platform === "win32" || platform === "windows") return "windows";
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "all") return "all";
  throw new Error(`Unsupported platform: ${platform}`);
}

/** @param {{ platform?: string, modelOnly?: boolean }} [opts] */
export function selectedKeys({ platform = process.platform, modelOnly = false } = {}) {
  const keys = ["model"];
  if (modelOnly) return keys;
  const target = normalizePlatform(platform);
  if (target === "all") keys.push("linux", "windows");
  else if (target === "linux" || target === "windows") keys.push(target);
  return keys;
}

export function verifyFileHash(filePath, expectedSha256) {
  if (!existsSync(filePath)) return false;
  return sha256(readFileSync(filePath)) === expectedSha256;
}

function writeAtomic(filePath, data, executable = false) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    if (executable && process.platform !== "win32") chmodSync(tmp, 0o755);
    renameSync(tmp, filePath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function isEntrySatisfied(entry, rootDir = ROOT) {
  if (entry.kind === "file") return verifyFileHash(join(rootDir, entry.dest), entry.sha256);
  return Object.entries(entry.files).every(([name, meta]) =>
    verifyFileHash(join(rootDir, entry.destDir, name), meta.sha256),
  );
}

export function extractZipEntry(entry, archiveBytes, rootDir = ROOT) {
  const actualArchive = sha256(archiveBytes);
  if (actualArchive !== entry.archiveSha256) {
    throw new Error(`SHA-256 mismatch for ${entry.url}: expected ${entry.archiveSha256}, got ${actualArchive}`);
  }
  const unpacked = unzipSync(archiveBytes);
  for (const [name, meta] of Object.entries(entry.files)) {
    const data = unpacked[name];
    if (!data) throw new Error(`Archive ${entry.url} is missing expected file ${name}`);
    const actual = sha256(data);
    if (actual !== meta.sha256) {
      throw new Error(`SHA-256 mismatch for ${name}: expected ${meta.sha256}, got ${actual}`);
    }
    writeAtomic(join(rootDir, entry.destDir, name), data, Boolean(meta.executable));
  }
}

async function downloadBytes(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Katraineo-fetch-resources" } });
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchResources({
  platform = process.platform,
  modelOnly = false,
  check = false,
  rootDir = ROOT,
} = {}) {
  const keys = selectedKeys({ platform, modelOnly });
  for (const key of keys) {
    const entry = RESOURCES[key];
    if (isEntrySatisfied(entry, rootDir)) {
      console.log(`ok (cached): ${key}`);
      continue;
    }
    if (check) {
      throw new Error(`Missing or modified resource: ${key}`);
    }
    console.log(`downloading ${key} from ${entry.url} ...`);
    const bytes = await downloadBytes(entry.url);
    if (entry.kind === "file") {
      const actual = sha256(bytes);
      if (actual !== entry.sha256) {
        throw new Error(`SHA-256 mismatch for ${entry.dest}: expected ${entry.sha256}, got ${actual}`);
      }
      writeAtomic(join(rootDir, entry.dest), bytes);
    } else {
      extractZipEntry(entry, bytes, rootDir);
    }
    console.log(`verified: ${key}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let platform = process.platform;
  let modelOnly = false;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--platform" && args[i + 1]) platform = args[++i];
    else if (args[i] === "--model-only") modelOnly = true;
    else if (args[i] === "--check") check = true;
    else {
      console.error(
        "usage: node scripts/fetch-resources.mjs [--platform linux|windows|macos|all] [--model-only] [--check]",
      );
      process.exit(2);
    }
  }
  await fetchResources({ platform, modelOnly, check });
}
