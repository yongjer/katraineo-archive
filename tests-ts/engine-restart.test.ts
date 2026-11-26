// Restarting the engine while an earlier restart is still stopping it (the settings changed twice in quick
// succession) starts it once, with the last settings.
import { describe, expect, it } from "vitest";
import { KataGoEngine, type EngineSettings, type EngineTransport } from "../src/core/engine";

type Handlers = Parameters<EngineTransport["setHandlers"]>[0];

/** A local engine whose stop takes a moment, as stopping KataGo does. */
class FakeLocal implements EngineTransport {
  handlers!: Handlers;
  started: EngineSettings[] = [];
  setHandlers(h: Handlers) {
    this.handlers = h;
  }
  async start(settings: EngineSettings) {
    this.started.push(settings);
  }
  async send() {}
  async stop() {
    await new Promise((r) => setTimeout(r, 20));
  }
  ready() {
    this.handlers.onStderr("Started, ready to begin handling requests");
  }
}

const settings = (model: string): EngineSettings => ({
  backend: "local",
  katago: "",
  altcommand: "",
  model,
  humanlike_model: "",
  config: "",
  max_visits: 10,
  fast_visits: 5,
  max_time: 1,
  wide_root_noise: 0,
  _enable_ownership: false,
});

async function running() {
  const transport = new FakeLocal();
  const engine = new KataGoEngine(transport, settings("first"));
  await engine.start();
  transport.ready();
  expect(engine.state).toBe("ready");
  transport.started.length = 0;
  return { engine, transport };
}

describe("overlapping restarts", () => {
  it("start the engine once, with the last settings", async () => {
    const { engine, transport } = await running();
    await Promise.all([engine.restart(settings("second")), engine.restart(settings("third"))]);
    expect(transport.started.map((s) => s.model)).toEqual(["third"]);
    transport.ready();
    expect(engine.state).toBe("ready");
  });

  it("switch to the new transport even when the last restart brings none", async () => {
    const { engine, transport } = await running();
    const remote = new FakeLocal();
    // the store passes a new transport only with the restart that changes its kind
    await Promise.all([engine.restart(settings("remote"), remote), engine.restart(settings("remote again"))]);
    expect(transport.started).toEqual([]);
    expect(remote.started.map((s) => s.model)).toEqual(["remote again"]);
    remote.ready();
    expect(engine.state).toBe("ready");
  });

  it("do not hold up a restart that comes after the last one finished", async () => {
    const { engine, transport } = await running();
    await engine.restart(settings("second"));
    await engine.restart(settings("third"));
    expect(transport.started.map((s) => s.model)).toEqual(["second", "third"]);
  });
});
