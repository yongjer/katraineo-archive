import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  extractZipEntry,
  isEntrySatisfied,
  normalizePlatform,
  RESOURCES,
  selectedKeys,
  sha256,
} from "../scripts/fetch-resources.mjs";

describe("fetch-resources", () => {
  it("selects the expected resource keys per platform", () => {
    expect(selectedKeys({ platform: "linux" })).toEqual(["model", "linux"]);
    expect(selectedKeys({ platform: "win32" })).toEqual(["model", "windows"]);
    expect(selectedKeys({ platform: "darwin" })).toEqual(["model"]);
    expect(selectedKeys({ platform: "all" })).toEqual(["model", "linux", "windows"]);
    expect(selectedKeys({ platform: "linux", modelOnly: true })).toEqual(["model"]);
    expect(normalizePlatform("macos")).toBe("macos");
    expect(() => normalizePlatform("freebsd")).toThrow(/Unsupported platform/);
  });

  it("extracts and verifies zip archives and rejects tampered payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "katraineo-fetch-"));
    try {
      const payload = new TextEncoder().encode("katago-binary-bytes");
      const archive = zipSync({ "katago.bin": payload });
      const entry = {
        kind: "zip",
        url: "https://example.test/katago.zip",
        archiveSha256: sha256(archive),
        destDir: "resources/KataGo",
        files: { "katago.bin": { sha256: sha256(payload), executable: true } },
      };

      expect(isEntrySatisfied(entry, dir)).toBe(false);
      extractZipEntry(entry, archive, dir);
      expect(isEntrySatisfied(entry, dir)).toBe(true);
      expect(readFileSync(join(dir, "resources/KataGo/katago.bin"), "utf8")).toBe("katago-binary-bytes");

      // tampering invalidates satisfaction
      writeFileSync(join(dir, "resources/KataGo/katago.bin"), "corrupted");
      expect(isEntrySatisfied(entry, dir)).toBe(false);

      // archive checksum mismatch is rejected
      const badEntry = { ...entry, archiveSha256: "0".repeat(64) };
      expect(() => extractZipEntry(badEntry, archive, dir)).toThrow(/SHA-256 mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins 64-char hex SHA-256 hashes for every resource", () => {
    const hex64 = /^[0-9a-f]{64}$/;
    expect(RESOURCES.model.sha256).toMatch(hex64);
    for (const key of ["linux", "windows"] as const) {
      const entry = RESOURCES[key];
      expect(entry.archiveSha256).toMatch(hex64);
      for (const meta of Object.values(entry.files)) expect(meta.sha256).toMatch(hex64);
    }
  });
});
