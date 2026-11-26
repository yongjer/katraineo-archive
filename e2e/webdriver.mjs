// A small W3C WebDriver client for tauri-driver, on Node's fetch, so the end-to-end tests need no packages.

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

/** WebDriver codes of special keys. */
export const Keys = {
  Control: "",
  Escape: "",
  Home: "",
  End: "",
  Left: "",
  Right: "",
  F3: "",
  F8: "",
};

export class WebDriverError extends Error {}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.value?.error) {
    throw new WebDriverError(
      `${method} ${path}: ${json.value?.error ?? res.status} ${json.value?.message ?? ""}`.trim(),
    );
  }
  return json.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond` returns something truthy (errors count as not yet), and return that. */
export async function until(cond, { timeout = 30000, interval = 250, what = "condition" } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      const v = await cond();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() - start > timeout)
      throw new Error(`timed out after ${timeout} ms waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await sleep(interval);
  }
}

export class Session {
  /** Start the app at `application` through tauri-driver at `url`. */
  static async start(url, application, args = []) {
    const value = await call(url, "POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application, args } } },
    });
    return new Session(url, value.sessionId);
  }

  /** Attach msedgedriver at `url` to a running WebView2 app with its debugging port at `debuggerAddress` (host:port). */
  static async attach(url, debuggerAddress) {
    const value = await call(url, "POST", "/session", {
      capabilities: {
        alwaysMatch: { browserName: "webview2", "ms:edgeChromium": true, "ms:edgeOptions": { debuggerAddress } },
      },
    });
    return new Session(url, value.sessionId);
  }

  constructor(url, id) {
    this.base = url;
    this.path = `/session/${id}`;
  }

  call(method, path, body) {
    return call(this.base, method, `${this.path}${path}`, body);
  }

  /** Run `script` (a function body; `arguments` holds `args`) in the page and return its result. */
  execute(script, ...args) {
    return this.call("POST", "/execute/sync", { script, args });
  }

  async find(css) {
    const v = await this.call("POST", "/element", { using: "css selector", value: css });
    return new Element(this, v[ELEMENT]);
  }

  async findAll(css) {
    const v = await this.call("POST", "/elements", { using: "css selector", value: css });
    return v.map((e) => new Element(this, e[ELEMENT]));
  }

  /** The first element matching `css` whose text contains `text`. */
  async findByText(css, text) {
    for (const e of await this.findAll(css)) if ((await e.text()).includes(text)) return e;
    throw new WebDriverError(`no ${css} with text ${JSON.stringify(text)}`);
  }

  waitFor(css, opts = {}) {
    return until(() => this.find(css), { what: css, ...opts });
  }

  waitForText(css, text, opts = {}) {
    return until(() => this.findByText(css, text), { what: `${css} with ${JSON.stringify(text)}`, ...opts });
  }

  /** Press keys together (characters, or codes from `Keys`), and release them. */
  async press(...keys) {
    const down = keys.map((value) => ({ type: "keyDown", value }));
    const up = [...keys].reverse().map((value) => ({ type: "keyUp", value }));
    await this.call("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions: [...down, ...up] }] });
    await this.call("DELETE", "/actions");
  }

  /** Click at a point of the window, in CSS pixels. */
  async clickAt(x, y) {
    await this.call("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", duration: 0, origin: "viewport", x: Math.round(x), y: Math.round(y) },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await this.call("DELETE", "/actions");
  }

  /** A PNG of the window, as a Buffer. */
  async screenshot() {
    return Buffer.from(await this.call("GET", "/screenshot"), "base64");
  }

  async close() {
    await this.call("DELETE", "").catch(() => {});
  }
}

export class Element {
  constructor(session, id) {
    this.session = session;
    this.id = id;
  }

  call(method, path, body) {
    return this.session.call(method, `/element/${this.id}${path}`, body);
  }

  click() {
    return this.call("POST", "/click", {});
  }

  text() {
    return this.call("GET", "/text");
  }

  attribute(name) {
    return this.call("GET", `/attribute/${name}`);
  }

  rect() {
    return this.call("GET", "/rect");
  }
}
