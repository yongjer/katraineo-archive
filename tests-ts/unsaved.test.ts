import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  autosave: null as string | null,
  savePath: "/games/saved.sgf" as string | null,
  savedContents: [] as string[],
  titles: [] as string[],
  closed: false,
}));

vi.mock("../src/state/platform", () => ({
  platform: {
    isDesktop: true,
    loadConfig: async () => null,
    saveConfig: async () => {},
    appVersion: async () => "2.0.0",
    checkForUpdate: async () => null,
    makeTransport: () => ({ setHandlers() {}, async start() {}, async send() {}, async stop() {} }),
    transportKind: () => "fake",
    takePendingOpenFile: async () => null,
    saveAutosave: async (sgf: string) => void (fake.autosave = sgf),
    loadAutosave: async () => fake.autosave,
    clearAutosave: async () => void (fake.autosave = null),
    setWindowTitle: async (title: string) => void fake.titles.push(title),
    closeWindow: async () => void (fake.closed = true),
    saveTextFile: async (contents: string) => {
      if (!fake.savePath) return null;
      fake.savedContents.push(contents);
      return fake.savePath;
    },
  },
}));

async function boot(initialAutosave: string | null = null) {
  Object.assign(fake, {
    autosave: initialAutosave,
    savePath: "/games/saved.sgf",
    savedContents: [],
    titles: [],
    closed: false,
  });
  vi.resetModules();
  const store = await import("../src/state/store");
  await store.init();
  return store;
}

describe("unsaved changes guard & autosave recovery", () => {
  it("tracks dirty state, autosaves edits, and guards destructive actions", async () => {
    const store = await boot();
    expect(store.useStore.getState().dirty).toBe(false);

    store.playAt([3, 3]);
    expect(store.useStore.getState().dirty).toBe(true);
    expect(fake.titles.at(-1)).toMatch(/^• /);

    await store.flushAutosave();
    expect(fake.autosave).toContain(";B[");

    // destructive action opens confirmation dialog
    let ran = false;
    store.guardUnsaved(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(store.useStore.getState().dialog).toBe("unsaved");

    // cancel keeps dirty state and does not run action
    await store.resolveUnsaved("cancel");
    expect(ran).toBe(false);
    expect(store.useStore.getState().dirty).toBe(true);

    // save writes file, clears dirty + autosave, and runs action
    store.guardUnsaved(() => {
      ran = true;
    });
    await store.resolveUnsaved("save");
    expect(ran).toBe(true);
    expect(store.useStore.getState().dirty).toBe(false);
    expect(fake.autosave).toBeNull();
    expect(fake.savedContents).toHaveLength(1);
  });

  it("intercepts window close when dirty and closes after discard", async () => {
    const store = await boot();
    expect(store.requestWindowClose()).toBe(false);

    store.setNote("check this tesuji");
    expect(store.useStore.getState().dirty).toBe(true);
    expect(store.requestWindowClose()).toBe(true);
    expect(store.useStore.getState().dialog).toBe("unsaved");

    await store.resolveUnsaved("discard");
    expect(fake.closed).toBe(true);
    expect(fake.autosave).toBeNull();
  });

  it("offers crash recovery on startup when an autosave snapshot exists", async () => {
    const store = await boot("(;GM[1]SZ[9];B[ee];W[cc])");
    expect(store.useStore.getState().dialog).toBe("recovery");
    expect(store.useStore.getState().recoverySgf).toContain("B[ee]");

    store.recoverAutosave();
    expect(store.useStore.getState().dialog).toBeNull();
    expect(store.useStore.getState().dirty).toBe(true);
    expect(store.useStore.getState().game?.root.nodesInTree.length).toBe(3);
  });
});
