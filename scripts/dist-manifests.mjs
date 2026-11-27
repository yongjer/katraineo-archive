#!/usr/bin/env node
// Generates zero-cost package manager manifests from built release artifacts:
//   - Homebrew Cask (katraineo.rb) for macOS Apple Silicon + Intel DMGs
//   - Scoop manifest (katraineo.json) for Windows NSIS installer
//
//   node scripts/dist-manifests.mjs <release dir> <version> <owner/repo> <out dir>

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Render a Homebrew Cask formula supporting both Apple Silicon and Intel DMGs.
 * @param {{ version: string, repo: string, arm64Sha256: string, x64Sha256: string }} opts
 */
export function buildHomebrewCask({ version, repo, arm64Sha256, x64Sha256 }) {
  return `cask "katraineo" do
  arch arm: "aarch64", intel: "x64"

  version "${version}"
  sha256 arm:   "${arm64Sha256}",
         intel: "${x64Sha256}"

  url "https://github.com/${repo}/releases/download/v#{version}/Katraineo_#{version}_#{arch}.dmg"
  name "Katraineo"
  desc "Go/Baduk/Weiqi analysis and training app with KataGo"
  homepage "https://github.com/${repo}"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Katraineo.app"

  caveats <<~EOS
    Katraineo is not signed with an Apple Developer certificate.
    Install with \`brew install --cask --no-quarantine\` or remove quarantine manually:
      xattr -dr com.apple.quarantine /Applications/Katraineo.app
  EOS

  zap trash: [
    "~/Library/Application Support/io.github.yongjer.katraineo",
    "~/Library/Caches/io.github.yongjer.katraineo",
  ]
end
`;
}

/**
 * Render a Scoop manifest targeting the Windows x64 NSIS installer.
 * @param {{ version: string, repo: string, setupName: string, setupSha256: string }} opts
 */
export function buildScoopManifest({ version, repo, setupName, setupSha256 }) {
  const manifest = {
    version,
    description: "Go/Baduk/Weiqi analysis and training app with KataGo",
    homepage: `https://github.com/${repo}`,
    license: "MIT",
    architecture: {
      "64bit": {
        url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(setupName)}`,
        hash: setupSha256,
        installer: {
          args: ["/S", "/D=$dir"],
        },
        uninstaller: {
          file: "uninstall.exe",
          args: ["/S"],
        },
      },
    },
    shortcuts: [["katraineo.exe", "Katraineo"]],
    checkver: {
      github: `https://github.com/${repo}`,
    },
    autoupdate: {
      architecture: {
        "64bit": {
          url: `https://github.com/${repo}/releases/download/v$version/Katraineo_$version_x64-setup.exe`,
        },
      },
    },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Scan `releaseDir` for the macOS DMGs and Windows NSIS installer, compute SHA-256 digests,
 * and write `katraineo.rb` and `katraineo.json` to `outDir`.
 * @param {{ releaseDir: string, version: string, repo: string, outDir: string }} opts
 */
export function generateDistManifests({ releaseDir, version, repo, outDir }) {
  const names = readdirSync(releaseDir);
  const armDmg = names.find((n) => n.endsWith("_aarch64.dmg"));
  const x64Dmg = names.find((n) => n.endsWith("_x64.dmg"));
  const winSetup = names.find((n) => n.endsWith("_x64-setup.exe"));
  const missing = [];
  if (!armDmg) missing.push("*_aarch64.dmg");
  if (!x64Dmg) missing.push("*_x64.dmg");
  if (!winSetup) missing.push("*_x64-setup.exe");
  if (missing.length) throw new Error(`Missing release assets for manifests: ${missing.join(", ")}`);

  const arm64Sha256 = sha256Hex(readFileSync(join(releaseDir, armDmg)));
  const x64Sha256 = sha256Hex(readFileSync(join(releaseDir, x64Dmg)));
  const setupSha256 = sha256Hex(readFileSync(join(releaseDir, winSetup)));

  mkdirSync(outDir, { recursive: true });
  const caskPath = join(outDir, "katraineo.rb");
  const scoopPath = join(outDir, "katraineo.json");
  writeFileSync(caskPath, buildHomebrewCask({ version, repo, arm64Sha256, x64Sha256 }));
  writeFileSync(scoopPath, buildScoopManifest({ version, repo, setupName: winSetup, setupSha256 }));
  return { caskPath, scoopPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [releaseDir, version, repo, outDir = releaseDir] = process.argv.slice(2);
  if (!releaseDir || !version || !repo) {
    console.error("usage: node scripts/dist-manifests.mjs <release dir> <version> <owner/repo> [out dir]");
    process.exit(2);
  }
  const { caskPath, scoopPath } = generateDistManifests({ releaseDir, version, repo, outDir });
  console.log(caskPath);
  console.log(scoopPath);
}
