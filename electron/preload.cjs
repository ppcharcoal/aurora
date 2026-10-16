// Gives the page `window.aurora` (used by electron/shims instead of Tauri's APIs).
const { contextBridge, ipcRenderer } = require("electron");

const arg = process.argv.find((a) => a.startsWith("--aurora="));
const init = arg ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(arg.slice(9)), (c) => c.charCodeAt(0)))) : { mediaBase: "", paths: {} };

const listeners = new Map(); // event name → Set of callbacks
ipcRenderer.on("aurora:event", (_e, name, payload) => {
  for (const cb of listeners.get(name) ?? []) {
    try {
      cb(payload);
    } catch (err) {
      console.error(err);
    }
  }
});

contextBridge.exposeInMainWorld("aurora", {
  mediaBase: init.mediaBase,
  paths: init.paths,
  invoke: (cmd, args) => ipcRenderer.invoke("aurora:invoke", cmd, args),
  on(name, cb) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return () => listeners.get(name)?.delete(cb);
  },
  async call(channel, ...args) {
    const r = await ipcRenderer.invoke(`aurora:${channel}`, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
});

// The title bar is the window's drag handle (Tauri's data-tauri-drag-region).
window.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = `[data-tauri-drag-region] { -webkit-app-region: drag; }
[data-tauri-drag-region] :is(button, input, a, select, textarea, [role="button"], label) { -webkit-app-region: no-drag; }`;
  document.head.appendChild(style);
});
