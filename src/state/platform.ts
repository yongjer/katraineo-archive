// Everything that differs between the Tauri desktop app and a plain browser (used for UI development).

import { resolveEngineBackend, type EngineSettings, type EngineTransport } from "../core/engine";
import packageJson from "../../package.json";

export interface OpenedFile {
  name: string;
  path: string | null;
  contents: string;
}

export interface ModelFile {
  path: string;
  name: string;
  size: number;
}

export interface DownloadProgress {
  name: string;
  received: number;
  total: number | null;
  done: boolean;
  error: string | null;
  path: string | null;
}

/** A newer version of the app, found by the update check. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface UpdateProgress {
  received: number;
  total: number | null;
}

export interface Platform {
  isDesktop: boolean;
  /** Model files on disk (bundled, downloaded, ~/.katrain, and next to `extraPaths`). */
  listModels(extraPaths: string[]): Promise<ModelFile[]>;
  /** Resolve a katagotraining.org endpoint to a model URL. */
  resolveModelEndpoint(url: string): Promise<string>;
  /** Download a model; resolves to the saved path. */
  downloadModel(name: string, url: string): Promise<string>;
  onDownloadProgress(cb: (p: DownloadProgress) => void): Promise<() => void>;
  readClipboard(): Promise<string | null>;
  writeClipboard(text: string): Promise<void>;
  /** Fetch a game record from an http(s) URL (pasting a link to an SGF). */
  fetchText(url: string): Promise<string>;
  /** A transport for these engine settings; `transportKind` tells when a restart needs a different one. */
  makeTransport(settings: EngineSettings): EngineTransport;
  transportKind(settings: EngineSettings): string;
  openGameFile(): Promise<OpenedFile | null>;
  /** Read a game file at a known disk path (recent files, OS file open). */
  readGameFile(path: string): Promise<OpenedFile>;
  /** Consume a game file path passed by the OS before the UI mounted. */
  takePendingOpenFile(): Promise<string | null>;
  /** Subscribe to game file paths forwarded by the OS while running (double-click, second instance). */
  onOpenGameFile(cb: (path: string) => void): Promise<() => void>;
  /** Files dropped onto the window. Resolves to an unsubscribe function. */
  onFileDrop(cb: (file: OpenedFile) => void): Promise<() => void>;
  /** Save to `path`, or ask where to save when path is null. Returns the path written, or null if cancelled. */
  saveTextFile(contents: string, suggestedName: string, path: string | null): Promise<string | null>;
  loadConfig(): Promise<string | null>;
  /** Move a saved config that could not be read aside, so that saving does not replace it. Resolves to where it is now. */
  keepUnreadableConfig(): Promise<string>;
  /** Tell the user something they must not miss, in a dialog. */
  showWarning(message: string): Promise<void>;
  saveConfig(contents: string): Promise<void>;
  /** Persist an autosave snapshot for crash recovery. */
  saveAutosave(contents: string): Promise<void>;
  /** Read an existing autosave snapshot, or null when none is stored. */
  loadAutosave(): Promise<string | null>;
  /** Remove any stored autosave snapshot. */
  clearAutosave(): Promise<void>;
  /** Update the native window title (or document.title in browser). */
  setWindowTitle(title: string): Promise<void>;
  /** Intercept window close: return true from `cb` to cancel immediate close. */
  onCloseRequested(cb: () => boolean): Promise<() => void>;
  /** Force-close the app window after confirmation. */
  closeWindow(): Promise<void>;
  appVersion(): Promise<string>;
  /** Ask the release page for a newer version of the app: null when this one is the newest. */
  checkForUpdate(): Promise<UpdateInfo | null>;
  /** Download, verify and install the update the last check found, then restart. Only returns (by rejecting) on failure. */
  installUpdate(onProgress: (p: UpdateProgress) => void): Promise<void>;
}

type Handlers = Parameters<EngineTransport["setHandlers"]>[0];

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------- Tauri
class TauriTransport implements EngineTransport {
  private handlers: Handlers | null = null;
  private generation = 0;
  private listening: Promise<void> | null = null;

  setHandlers(h: Handlers) {
    this.handlers = h;
  }

  private listen(): Promise<void> {
    if (!this.listening) {
      this.listening = (async () => {
        const { listen } = await import("@tauri-apps/api/event");
        type Line = { generation: number; line: string };
        // Accept events from the newest process only; a restart bumps the generation.
        const current = (g: number) => {
          if (g < this.generation) return false;
          this.generation = g;
          return true;
        };
        await listen<Line>(
          "katago-stdout",
          (e) => current(e.payload.generation) && this.handlers?.onStdout(e.payload.line),
        );
        await listen<Line>(
          "katago-stderr",
          (e) => current(e.payload.generation) && this.handlers?.onStderr(e.payload.line),
        );
        await listen<{ generation: number; code: number | null }>(
          "katago-exit",
          (e) => e.payload.generation === this.generation && this.handlers?.onExit(e.payload.code),
        );
      })();
    }
    return this.listening;
  }

  async start(settings: EngineSettings) {
    await this.listen();
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ generation: number; command: string[]; remote: boolean }>("engine_start", {
      settings,
    });
    this.generation = Math.max(this.generation, result.generation);
    if (result.remote) {
      this.handlers?.onStderr(`Connected to remote KataGo at ${result.command.join(" ")}`);
      return { ready: true };
    }
    this.handlers?.onStderr(`Started KataGo with ${result.command.join(" ")}`);
  }

  async send(line: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("engine_send", { line });
  }

  async stop() {
    const { invoke } = await import("@tauri-apps/api/core");
    this.generation++;
    await invoke("engine_stop");
  }
}

const GAME_FILTERS = [{ name: "Go game records", extensions: ["sgf", "gib", "ngf"] }];

const tauriPlatform: Platform = {
  isDesktop: true,
  async listModels(extraPaths) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ModelFile[]>("list_models", { extraPaths });
  },
  async resolveModelEndpoint(url) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("resolve_model_endpoint", { url });
  },
  async downloadModel(name, url) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("download_model", { name, url });
  },
  async onDownloadProgress(cb) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<DownloadProgress>("model-download", (e) => cb(e.payload));
  },
  async readClipboard() {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return readText();
  },
  async writeClipboard(text) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  },
  async fetchText(url) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("fetch_text", { url });
  },
  makeTransport: () => new TauriTransport(), // the Rust side runs local, custom and remote engines
  transportKind: () => "tauri",
  async openGameFile() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await open({ multiple: false, directory: false, filters: GAME_FILTERS });
    if (!path || Array.isArray(path)) return null;
    const contents = await invoke<string>("read_game_file", { path });
    return { name: path.split(/[\\/]/).pop() ?? path, path, contents };
  },
  async readGameFile(path) {
    const { invoke } = await import("@tauri-apps/api/core");
    const contents = await invoke<string>("read_game_file", { path });
    return { name: path.split(/[\\/]/).pop() ?? path, path, contents };
  },
  async takePendingOpenFile() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("take_pending_open_file");
  },
  async onOpenGameFile(cb) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<string>("open-game-file", (e) => cb(e.payload));
  },
  async onFileDrop(cb) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const { invoke } = await import("@tauri-apps/api/core");
    return getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop" || !e.payload.paths.length) return;
      const path = e.payload.paths[0];
      const name = path.split(/[\\/]/).pop() ?? path;
      if (!/\.(sgf|gib|ngf)$/i.test(name)) return;
      cb({ name, path, contents: await invoke<string>("read_game_file", { path }) });
    });
  },
  async saveTextFile(contents, suggestedName, path) {
    const { invoke } = await import("@tauri-apps/api/core");
    let target = path;
    if (!target) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      target = await save({ defaultPath: suggestedName, filters: [{ name: "SGF", extensions: ["sgf"] }] });
      if (!target) return null;
    }
    await invoke("write_text_file", { path: target, contents });
    return target;
  },
  async loadConfig() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("load_config");
  },
  async keepUnreadableConfig() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("keep_unreadable_config");
  },
  async showWarning(text) {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(text, { title: "Katraineo", kind: "warning" });
  },
  async saveConfig(contents) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_config", { contents });
  },
  async saveAutosave(contents) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_autosave", { contents });
  },
  async loadAutosave() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string | null>("load_autosave");
  },
  async clearAutosave() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("clear_autosave");
  },
  async setWindowTitle(title) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  },
  async onCloseRequested(cb) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().onCloseRequested((e) => {
      if (cb()) e.preventDefault();
    });
  },
  async closeWindow() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  },
  async appVersion() {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
  async checkForUpdate() {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{ version: string; current_version: string; notes: string | null } | null>(
      "update_check",
    );
    return info && { version: info.version, currentVersion: info.current_version, notes: info.notes };
  },
  async installUpdate(onProgress) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    const stop = await listen<UpdateProgress>("update-progress", (e) => onProgress(e.payload));
    try {
      await invoke("update_install");
    } finally {
      stop();
    }
  },
};

// ---------------------------------------------------------------- Browser (development)
/**
 * Talks to scripts/engine-bridge.mjs, a tiny local server that runs KataGo for browser-based UI work.
 * Without a bridge the app still runs; the engine simply reports that it is not available.
 */
class HttpBridgeTransport implements EngineTransport {
  private handlers: Handlers | null = null;
  private source: EventSource | null = null;
  private base: string | null = null;
  private token = "";
  constructor(bridge: string | null) {
    if (bridge) {
      const url = new URL(bridge);
      this.token = url.searchParams.get("token") ?? "";
      this.base = url.origin;
    }
  }

  private url(path: string, extra = "") {
    return `${this.base}${path}?token=${encodeURIComponent(this.token)}${extra}`;
  }

  setHandlers(h: Handlers) {
    this.handlers = h;
  }

  async start(settings: EngineSettings) {
    if (!this.base)
      throw new Error(
        "No KataGo available in the browser. Run the desktop app, or start scripts/engine-bridge.mjs and open the URL it prints",
      );
    this.source?.close();
    const res = await fetch(this.url("/start"), { method: "POST", body: JSON.stringify(settings) });
    if (!res.ok) throw new Error(await res.text());
    const { generation } = (await res.json()) as { generation: number };
    this.source = new EventSource(this.url("/events", `&generation=${generation}`));
    this.source.addEventListener("stdout", (e) => this.handlers?.onStdout((e as MessageEvent).data));
    this.source.addEventListener("stderr", (e) => this.handlers?.onStderr((e as MessageEvent).data));
    this.source.addEventListener("exit", (e) => {
      this.source?.close();
      this.handlers?.onExit(Number((e as MessageEvent).data));
    });
  }

  async send(line: string) {
    await fetch(this.url("/send"), { method: "POST", body: line });
  }

  async stop() {
    this.source?.close();
    this.source = null;
    if (this.base) await fetch(this.url("/stop"), { method: "POST" }).catch(() => {});
  }
}

/** A remote KataGo analysis engine over a WebSocket, straight from the browser (development builds). */
class WebSocketTransport implements EngineTransport {
  private handlers: Handlers | null = null;
  private ws: WebSocket | null = null;

  setHandlers(h: Handlers) {
    this.handlers = h;
  }

  start(settings: EngineSettings) {
    this.ws?.close();
    const url = (settings.remote_url ?? "").trim();
    return new Promise<{ ready: boolean }>((resolve, reject) => {
      const ws = new WebSocket(url);
      let open = false;
      ws.onopen = () => {
        open = true;
        this.handlers?.onStderr(`Connected to remote KataGo at ${url}`);
        resolve({ ready: true });
      };
      ws.onmessage = async (e) => {
        const text = typeof e.data === "string" ? e.data : await new Response(e.data as Blob).text();
        for (const line of text.split(/\r?\n/)) if (line.trim()) this.handlers?.onStdout(line);
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (!open) return reject(new Error(e.reason || `connection failed (${e.code})`));
        this.handlers?.onStderr(`Remote KataGo disconnected: ${e.reason || "closed by remote"}`);
        this.handlers?.onExit(null);
      };
      this.ws = ws;
    });
  }

  async send(line: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("Remote KataGo is disconnected");
    this.ws.send(line);
  }

  async stop() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

const browserPlatform: Platform = {
  isDesktop: false,
  async listModels() {
    return [];
  },
  async resolveModelEndpoint() {
    throw new Error("Model downloads need the desktop app");
  },
  async downloadModel() {
    throw new Error("Model downloads need the desktop app");
  },
  async onDownloadProgress() {
    return () => {};
  },
  async readClipboard() {
    return navigator.clipboard.readText();
  },
  async writeClipboard(text) {
    await navigator.clipboard.writeText(text);
  },
  async fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return res.text();
  },
  makeTransport: (settings) =>
    resolveEngineBackend(settings) === "remote"
      ? new WebSocketTransport()
      : new HttpBridgeTransport(new URLSearchParams(window.location.search).get("bridge")),
  transportKind: (settings) => (resolveEngineBackend(settings) === "remote" ? "websocket" : "bridge"),
  openGameFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".sgf,.gib,.ngf";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        resolve({ name: file.name, path: null, contents: await file.text() });
      };
      input.click();
    });
  },
  async readGameFile() {
    throw new Error("Opening files by path needs the desktop app");
  },
  async takePendingOpenFile() {
    return null;
  },
  async onOpenGameFile() {
    return () => {};
  },
  async onFileDrop(cb) {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file) cb({ name: file.name, path: null, contents: await file.text() });
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  },
  async saveTextFile(contents, suggestedName) {
    const url = URL.createObjectURL(new Blob([contents], { type: "application/x-go-sgf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return suggestedName;
  },
  async loadConfig() {
    try {
      return localStorage.getItem("katrain-config");
    } catch {
      return null;
    }
  },
  async keepUnreadableConfig() {
    const key = "katrain-config.broken";
    localStorage.setItem(key, localStorage.getItem("katrain-config") ?? "");
    localStorage.removeItem("katrain-config");
    return `localStorage "${key}"`;
  },
  async showWarning(text) {
    window.alert(text);
  },
  async saveConfig(contents) {
    try {
      localStorage.setItem("katrain-config", contents);
    } catch {
      /* storage unavailable */
    }
  },
  async saveAutosave(contents) {
    try {
      localStorage.setItem("katraineo-autosave", contents);
    } catch {
      /* storage unavailable */
    }
  },
  async loadAutosave() {
    try {
      return localStorage.getItem("katraineo-autosave");
    } catch {
      return null;
    }
  },
  async clearAutosave() {
    try {
      localStorage.removeItem("katraineo-autosave");
    } catch {
      /* storage unavailable */
    }
  },
  async setWindowTitle(title) {
    if (typeof document !== "undefined") document.title = title;
  },
  async onCloseRequested(cb) {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (cb()) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  },
  async closeWindow() {
    window.close();
  },
  async appVersion() {
    return packageJson.version;
  },
  async checkForUpdate() {
    return null; // a browser always loads the current version
  },
  async installUpdate() {
    throw new Error("Updates need the desktop app");
  },
};

export const platform: Platform = isTauri ? tauriPlatform : browserPlatform;
