// The version of the app is recorded in several files (scripts/set-version.mjs sets them all); they must agree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { msiVersion } from "../scripts/set-version.mjs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the app version", () => {
  const version: string = JSON.parse(read("package.json")).version;

  it("is the same everywhere", () => {
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(version);
    expect(lock.packages[""].version).toBe(version);
    expect(/^version = "([^"]+)"$/m.exec(read("src-tauri/Cargo.toml"))?.[1]).toBe(version);
    expect(/^name = "katraineo"\nversion = "([^"]+)"$/m.exec(read("src-tauri/Cargo.lock"))?.[1]).toBe(version);
    const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(tauri.version).toBe("../package.json");
    expect(tauri.bundle.windows.wix.version).toBe(msiVersion(version));
  });

  it("gives Windows Installer only numbers", () => {
    expect(msiVersion("2.0.0-alpha.1")).toBe("2.0.0");
    expect(msiVersion("2.1.3")).toBe("2.1.3");
    expect(() => msiVersion("2.0")).toThrow();
    expect(() => msiVersion("256.0.0")).toThrow();
  });
});
