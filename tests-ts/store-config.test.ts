// A saved config that cannot be read is kept, before the next save would replace it, and the user is told.
import { describe, expect, it, vi } from "vitest";
import { isUnreadableConfig } from "../src/state/config";

const fake = vi.hoisted(() => ({
  stored: null as string | null,
  keepFails: false,
  /** platform calls about the config, in order */
  calls: [] as string[],
  warnings: [] as string[],
}));

vi.mock("../src/state/platform", () => ({
  platform: {
    isDesktop: true,
    loadConfig: async () => fake.stored,
    keepUnreadableConfig: async () => {
      fake.calls.push("keep");
      if (fake.keepFails) throw new Error("locked");
      return "/home/me/.config/katraineo/config.broken.json";
    },
    saveConfig: async () => void fake.calls.push("save"),
    showWarning: async (message: string) => void fake.warnings.push(message),
    appVersion: async () => "0.0.0",
    checkForUpdate: async () => null,
    makeTransport: () => ({ setHandlers() {}, async start() {}, async send() {}, async stop() {} }),
    transportKind: () => "fake",
  },
}));

/** Start the app (a fresh store) with this saved config. */
async function start(stored: string | null, keepFails = false) {
  Object.assign(fake, { stored, keepFails, calls: [], warnings: [] });
  vi.resetModules();
  const store = await import("../src/state/store");
  await store.init();
  return store;
}

describe("the saved config", () => {
  it("is unreadable only when it is not a settings object at all", () => {
    expect(isUnreadableConfig(null)).toBe(false);
    expect(isUnreadableConfig(" \n")).toBe(false);
    expect(isUnreadableConfig('{"general": {"lang": "de"}}')).toBe(false);
    expect(isUnreadableConfig('{"general": {"lang": 3}}')).toBe(false); // a wrong value is ignored, the rest applies
    expect(isUnreadableConfig('{"general": {"lang": "de"')).toBe(true);
    expect(isUnreadableConfig("[]")).toBe(true);
    expect(isUnreadableConfig("\0\0\0\0")).toBe(true);
  });

  it("is kept before anything is saved when it cannot be read, and the user is told where", async () => {
    const store = await start('{"general": {"lang": "de"}, "trainer": {"eval_sh');
    store.updateConfig((c) => void (c.trainer.show_move_numbers = !c.trainer.show_move_numbers));
    expect(fake.calls[0]).toBe("keep");
    expect(fake.calls).toContain("save");
    expect(fake.warnings).toHaveLength(1);
    expect(fake.warnings[0]).toContain("could not be read");
    expect(fake.warnings[0]).toContain("/home/me/.config/katraineo/config.broken.json");
    expect(store.useStore.getState().config.general.lang).toBe("en"); // the defaults
  });

  it("still starts, with the defaults, when it cannot be kept", async () => {
    const store = await start("{", true);
    expect(fake.warnings).toHaveLength(1);
    expect(fake.warnings[0]).toContain("could not be read");
    expect(fake.warnings[0]).not.toContain("config.broken.json");
    expect(store.useStore.getState().ready).toBe(true);
  });

  it("is left alone when it can be read, or when there is none yet", async () => {
    const store = await start(JSON.stringify({ general: { lang: "de" } }));
    expect(store.useStore.getState().config.general.lang).toBe("de");
    expect([fake.calls, fake.warnings]).toEqual([[], []]);
    await start(null);
    expect([fake.calls, fake.warnings]).toEqual([[], []]);
  });
});
