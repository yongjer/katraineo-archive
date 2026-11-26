// Updates of the app itself: the check at startup, a check from the menu, and installing.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo, UpdateProgress } from "../src/state/platform";

const fake = vi.hoisted(() => ({
  config: null as string | null,
  checks: 0,
  check: async (): Promise<UpdateInfo | null> => null,
  install: async (_onProgress: (p: UpdateProgress) => void): Promise<void> => {},
}));

vi.mock("../src/state/platform", () => ({
  platform: {
    isDesktop: true,
    loadConfig: async () => fake.config,
    saveConfig: async () => {},
    makeTransport: () => ({ setHandlers() {}, async start() {}, async send() {}, async stop() {} }),
    transportKind: () => "fake",
    appVersion: async () => "2.0.0-alpha.1",
    checkForUpdate: () => {
      fake.checks++;
      return fake.check();
    },
    installUpdate: (onProgress: (p: UpdateProgress) => void) => fake.install(onProgress),
  },
}));

import { checkForUpdates, init, installUpdate, useStore } from "../src/state/store";

const NEWER: UpdateInfo = { version: "2.0.0-alpha.2", currentVersion: "2.0.0-alpha.1", notes: "Fixes" };
const update = () => useStore.getState().update;

const until = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("updates", () => {
  beforeAll(async () => {
    fake.check = async () => {
      throw new Error("offline");
    };
    await init();
    await until(() => fake.checks === 1 && update().currentVersion !== "");
  });

  beforeEach(() => {
    useStore.setState((s) => ({ update: { ...s.update, phase: "idle", info: null, progress: null, error: null } }));
  });

  it("checks at startup and only logs a failure there", () => {
    expect(update().currentVersion).toBe("2.0.0-alpha.1");
    expect(update().phase).toBe("idle");
    expect(update().error).toBeNull();
    expect(useStore.getState().logs.some((l) => l.message.includes("offline"))).toBe(true);
  });

  it("shows a failed check from the menu", async () => {
    await checkForUpdates(true);
    expect(update().phase).toBe("error");
    expect(update().error).toContain("offline");
  });

  it("says when this is the latest version, but only after a check from the menu", async () => {
    fake.check = async () => null;
    await checkForUpdates(false);
    expect(update().phase).toBe("idle");
    await checkForUpdates(true);
    expect(update().phase).toBe("latest");
  });

  it("offers a newer version", async () => {
    fake.check = async () => NEWER;
    await checkForUpdates(false);
    expect(update().phase).toBe("available");
    expect(update().info).toEqual(NEWER);
  });

  it("reports the download, and keeps the update to retry after a failure", async () => {
    fake.check = async () => NEWER;
    await checkForUpdates(true);
    const seen: (UpdateProgress | null)[] = [];
    fake.install = async (onProgress) => {
      onProgress({ received: 10, total: 100 });
      seen.push(update().progress);
      expect(update().phase).toBe("installing");
      throw new Error("bad signature");
    };
    await installUpdate();
    expect(seen).toEqual([{ received: 10, total: 100 }]);
    expect(update().phase).toBe("error");
    expect(update().error).toContain("bad signature");
    expect(update().info).toEqual(NEWER);
  });

  it("does not check again while installing", async () => {
    fake.check = async () => NEWER;
    await checkForUpdates(true);
    let finish = () => {};
    fake.install = () => new Promise<void>((resolve) => (finish = resolve));
    const installing = installUpdate();
    const checks = fake.checks;
    await checkForUpdates(true);
    expect(fake.checks).toBe(checks);
    expect(update().phase).toBe("installing");
    finish();
    await installing;
  });
});

describe("the startup check", () => {
  it("can be turned off in the settings", async () => {
    vi.resetModules();
    fake.checks = 0;
    fake.config = JSON.stringify({ general: { check_for_updates: false } });
    const store = await import("../src/state/store");
    await store.init();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.useStore.getState().config.general.check_for_updates).toBe(false);
    expect(fake.checks).toBe(0);
  });
});
