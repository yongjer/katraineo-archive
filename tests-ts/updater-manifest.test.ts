// latest.json, the manifest the app's updater reads (scripts/updater-manifest.mjs).
import { describe, expect, it } from "vitest";
import { buildManifest, platformsFor, signedVersion } from "../scripts/updater-manifest.mjs";

/** A .sig file as `tauri signer sign --app-version` writes it (the signature bytes do not matter here). */
const sig = (file: string, version: string | null) =>
  Buffer.from(
    "untrusted comment: signature from tauri secret key\nRUQAAAA=\n" +
      `trusted comment: timestamp:1795532802\tfile:${file}${version ? `\tversion:${version}` : ""}\nAAAA\n`,
  ).toString("base64");

const V = "2.0.0-alpha.2";
const NAMES = [
  "Katraineo_2.0.0-alpha.2_aarch64.app.tar.gz",
  "Katraineo_2.0.0-alpha.2_x64.app.tar.gz",
  "Katraineo_2.0.0-alpha.2_x64-setup.exe",
  "Katraineo_2.0.0_x64_en-US.msi",
  "Katraineo_2.0.0-alpha.2_amd64.AppImage",
  "Katraineo_2.0.0-alpha.2_amd64.deb",
];
const files = (version: string | null = V) => NAMES.map((name) => ({ name, signature: sig(name, version) }));
const release = { version: V, notes: "notes", pubDate: "2026-11-24T00:00:00Z", baseUrl: "https://example.com/dl/" };

describe("the updater manifest", () => {
  it("maps each installer to the platforms it updates", () => {
    expect(platformsFor(NAMES[0])).toEqual(["darwin-aarch64", "darwin-aarch64-app"]);
    expect(platformsFor(NAMES[1])).toEqual(["darwin-x86_64", "darwin-x86_64-app"]);
    expect(platformsFor(NAMES[2])).toEqual(["windows-x86_64", "windows-x86_64-nsis"]);
    expect(platformsFor(NAMES[3])).toEqual(["windows-x86_64-msi"]);
    expect(platformsFor(NAMES[4])).toEqual(["linux-x86_64", "linux-x86_64-appimage"]);
    expect(platformsFor(NAMES[5])).toEqual(["linux-x86_64-deb"]);
    expect(platformsFor("Katraineo_2.0.0_aarch64.dmg")).toEqual([]);
    expect(platformsFor("Katraineo.app.tar.gz")).toEqual([]); // the arch must be in the name
  });

  it("reads the version a signature is bound to", () => {
    expect(signedVersion(sig("a", V))).toBe(V);
    expect(signedVersion(sig("a", null))).toBeNull();
  });

  it("lists every platform with its signature and URL", () => {
    const m = buildManifest({ ...release, files: files() });
    expect(m.version).toBe(V);
    expect(m.pub_date).toBe(release.pubDate);
    expect(Object.keys(m.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-aarch64-app",
      "darwin-x86_64",
      "darwin-x86_64-app",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "windows-x86_64",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ]);
    expect(m.platforms["windows-x86_64"].url).toBe("https://example.com/dl/Katraineo_2.0.0-alpha.2_x64-setup.exe");
    expect(m.platforms["linux-x86_64-deb"].signature).toBe(sig(NAMES[5], V));
  });

  it("refuses signatures for another version, or none", () => {
    expect(() => buildManifest({ ...release, files: files("2.0.0-alpha.1") })).toThrow(/signed for version 2.0.0-alpha.1/);
    expect(() => buildManifest({ ...release, files: files(null) })).toThrow(/\(none\)/);
  });

  it("refuses a release that misses a platform", () => {
    const some = files().filter((f) => !f.name.includes("x64.app"));
    expect(() => buildManifest({ ...release, files: some })).toThrow(/darwin-x86_64/);
  });
});
