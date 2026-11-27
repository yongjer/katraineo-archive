import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateDistManifests, sha256Hex } from "../scripts/dist-manifests.mjs";

describe("distribution manifests (Homebrew Cask & Scoop)", () => {
  it("generates Homebrew Cask and Scoop manifest with matching SHA-256 digests", () => {
    const dir = mkdtempSync(join(tmpdir(), "katraineo-dist-"));
    try {
      const armBytes = Buffer.from("arm64-dmg-bytes");
      const x64Bytes = Buffer.from("x64-dmg-bytes");
      const winBytes = Buffer.from("win-setup-bytes");
      writeFileSync(join(dir, "Katraineo_2.0.0_aarch64.dmg"), armBytes);
      writeFileSync(join(dir, "Katraineo_2.0.0_x64.dmg"), x64Bytes);
      writeFileSync(join(dir, "Katraineo_2.0.0_x64-setup.exe"), winBytes);

      const outDir = join(dir, "out");
      const { caskPath, scoopPath } = generateDistManifests({
        releaseDir: dir,
        version: "2.0.0",
        repo: "yongjer/katraineo",
        outDir,
      });

      const cask = readFileSync(caskPath, "utf8");
      expect(cask).toContain('version "2.0.0"');
      expect(cask).toContain(`arm:   "${sha256Hex(armBytes)}"`);
      expect(cask).toContain(`intel: "${sha256Hex(x64Bytes)}"`);
      expect(cask).toContain("--no-quarantine");
      expect(cask).toContain('app "Katraineo.app"');

      const scoop = JSON.parse(readFileSync(scoopPath, "utf8"));
      expect(scoop.version).toBe("2.0.0");
      expect(scoop.architecture["64bit"].hash).toBe(sha256Hex(winBytes));
      expect(scoop.architecture["64bit"].url).toBe(
        "https://github.com/yongjer/katraineo/releases/download/v2.0.0/Katraineo_2.0.0_x64-setup.exe",
      );
      expect(scoop.architecture["64bit"].installer.args).toEqual(["/S", "/D=$dir"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when required installers are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "katraineo-dist-empty-"));
    try {
      expect(() =>
        generateDistManifests({ releaseDir: dir, version: "2.0.0", repo: "yongjer/katraineo", outDir: dir }),
      ).toThrow(/Missing release assets/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
