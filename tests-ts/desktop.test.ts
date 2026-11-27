import { describe, expect, it, vi } from "vitest";
import { addRecentFile } from "../src/state/config";

const fake = vi.hoisted(() => ({
  pending: null as string | null,
  files: new Map<string, string>(),
  saved: [] as string[],
}));

vi.mock("../src/state/platform", () => ({
  platform: {
    isDesktop: true,
    loadConfig: async () => null,
    saveConfig: async (contents: string) => void fake.saved.push(contents),
    appVersion: async () => "2.0.0",
    checkForUpdate: async () => null,
    makeTransport: () => ({ setHandlers() {}, async start() {}, async send() {}, async stop() {} }),
    transportKind: () => "fake",
    takePendingOpenFile: async () => {
      const p = fake.pending;
      fake.pending = null;
      return p;
    },
    readGameFile: async (path: string) => {
      const contents = fake.files.get(path);
      if (!contents) throw new Error("missing");
      return { name: path.split(/[\\/]/).pop() ?? path, path, contents };
    },
  },
}));

describe("recent files & OS file opening", () => {
  it("deduplicates and caps recent file paths", () => {
    let list: string[] = [];
    list = addRecentFile(list, "/a/1.sgf", 3);
    list = addRecentFile(list, "/a/2.sgf", 3);
    list = addRecentFile(list, "/a/3.sgf", 3);
    list = addRecentFile(list, "/a/2.sgf", 3);
    expect(list).toEqual(["/a/2.sgf", "/a/3.sgf", "/a/1.sgf"]);
    list = addRecentFile(list, "/a/4.sgf", 3);
    expect(list).toEqual(["/a/4.sgf", "/a/2.sgf", "/a/3.sgf"]);
  });

  it("opens a pending OS file on startup and records recent files", async () => {
    fake.files.set("/games/match.sgf", "(;GM[1]SZ[9]PB[Black]PW[White];B[ee];W[cc])");
    fake.files.set("/games/other.sgf", "(;GM[1]SZ[9];B[dd])");
    fake.pending = "/games/match.sgf";
    vi.resetModules();
    const store = await import("../src/state/store");
    await store.init();
    expect(store.useStore.getState().game?.sgfFilename).toBe("/games/match.sgf");
    expect(store.useStore.getState().config.general.recent_files).toEqual(["/games/match.sgf"]);

    await store.openGamePath("/games/other.sgf");
    expect(store.useStore.getState().config.general.recent_files).toEqual(["/games/other.sgf", "/games/match.sgf"]);

    store.clearRecentFiles();
    expect(store.useStore.getState().config.general.recent_files).toEqual([]);
  });
});
