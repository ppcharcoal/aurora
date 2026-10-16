// Aurora for Linux (Electron). Draws the same Svelte app as the Tauri
// version in Chromium, which runs smoothly on NVIDIA + Wayland (Hyprland)
// where WebKitGTK lags. Everything else (library, downloads, Last.fm,
// backups…) is the unchanged Rust code, running as the `aurora-core` helper
// process (src-tauri/src/core.rs). This file starts it, opens the window and
// passes calls between the two.

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");

app.setName("Aurora");
// Wayland's app id / X11 class: matches aurora.desktop and Hyprland window rules.
app.setDesktopName?.("aurora.desktop");

// Native Wayland when available (X11 otherwise), at the monitor's own refresh rate.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");
// AURORA_GPU=0 aurora: draw without the graphics card (old/broken drivers).
if (process.env.AURORA_GPU === "0") app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------- the Rust helper ----------

function corePath() {
  if (process.env.AURORA_CORE) return process.env.AURORA_CORE;
  if (app.isPackaged) return path.join(process.resourcesPath, "aurora-core");
  return path.join(__dirname, "..", "src-tauri", "target", "release", "aurora-core");
}

let core = null; // { socket, pending: Map, nextId }
let coreProc = null;
let win = null;

function startCore() {
  return new Promise((resolve, reject) => {
    const proc = spawn(corePath(), [], { stdio: ["ignore", "pipe", "inherit"] });
    coreProc = proc;
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (!quitting) {
        dialog.showErrorBox("Aurora stopped", `Aurora's background helper stopped unexpectedly (code ${code}). Please start Aurora again.`);
        app.exit(1);
      }
    });
    const lines = readline.createInterface({ input: proc.stdout });
    lines.once("line", (line) => {
      const m = /^AURORA_CORE (\d+) ([0-9a-f]+)$/.exec(line.trim());
      if (!m) return reject(new Error(`Unexpected helper output: ${line}`));
      const socket = net.connect({ host: "127.0.0.1", port: Number(m[1]) }, () => {
        socket.setNoDelay(true);
        socket.write(m[2] + "\n");
        core = { socket, pending: new Map(), nextId: 1 };
        readline.createInterface({ input: socket }).on("line", onCoreLine);
        resolve();
      });
      socket.on("error", reject);
      socket.on("close", () => {
        for (const done of core?.pending.values() ?? []) done({ ok: false, error: "Aurora's helper stopped" });
      });
    });
  });
}

function onCoreLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.event) {
    win?.webContents.send("aurora:event", msg.event, msg.payload);
    return;
  }
  const done = core.pending.get(msg.id);
  if (done) {
    core.pending.delete(msg.id);
    done({ ok: msg.ok, data: msg.data, error: msg.error });
  }
}

function callCore(cmd, args) {
  return new Promise((resolve) => {
    if (!core) return resolve({ ok: false, error: "Aurora's helper isn't running" });
    const id = core.nextId++;
    core.pending.set(id, resolve);
    core.socket.write(JSON.stringify({ id, cmd, args: args ?? {} }) + "\n");
  });
}

// ---------- calls from the window ----------

ipcMain.handle("aurora:invoke", (_e, cmd, args) => callCore(String(cmd), args));

const wrap = (fn) => async (_e, ...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const handlers = {
  "win:show": () => {
    if (win && !win.isVisible()) win.show();
  },
  "win:minimize": () => win?.minimize(),
  "win:toggleMaximize": () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()),
  "win:close": () => win?.close(),
  "win:isMaximized": () => !!win?.isMaximized(),

  "dialog:open": async (o = {}) => {
    const properties = [o.directory ? "openDirectory" : "openFile", "createDirectory"];
    if (o.multiple) properties.push("multiSelections");
    const r = await dialog.showOpenDialog(win, {
      title: o.title,
      defaultPath: o.defaultPath,
      filters: o.filters,
      properties,
    });
    if (r.canceled || !r.filePaths.length) return null;
    return o.multiple ? r.filePaths : r.filePaths[0];
  },
  "dialog:save": async (o = {}) => {
    const r = await dialog.showSaveDialog(win, { title: o.title, defaultPath: o.defaultPath, filters: o.filters });
    return r.canceled || !r.filePath ? null : r.filePath;
  },
  "dialog:ask": async (msg, o = {}) => {
    const r = await dialog.showMessageBox(win, {
      type: o.kind === "error" ? "error" : o.kind === "warning" ? "warning" : "question",
      title: o.title ?? "Aurora",
      message: String(msg),
      buttons: [o.okLabel ?? "Yes", o.cancelLabel ?? "No"],
      defaultId: 0,
      cancelId: 1,
    });
    return r.response === 0;
  },
  "dialog:message": async (msg, o = {}) => {
    await dialog.showMessageBox(win, {
      type: o.kind === "error" ? "error" : o.kind === "warning" ? "warning" : "info",
      title: o.title ?? "Aurora",
      message: String(msg),
      buttons: [o.okLabel ?? "OK"],
    });
  },

  "open:url": async (url) => {
    if (!/^(https?|mailto):/i.test(url)) throw new Error("Only web links can be opened");
    await shell.openExternal(url);
  },
  "open:path": async (p) => {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  },
  "open:reveal": async (p) => {
    if (!fs.existsSync(p)) throw new Error(`${p} doesn't exist any more`);
    shell.showItemInFolder(p);
  },
};
for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(`aurora:${name}`, wrap(fn));

// ---------- the window ----------

let mediaBase = "";

function createWindow() {
  win = new BrowserWindow({
    title: "Aurora",
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    frame: false,
    show: false,
    backgroundColor: "#1a1622",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Keep playing and updating normally while minimised or on another workspace.
      backgroundThrottling: false,
      additionalArguments: [
        "--aurora=" +
          Buffer.from(
            JSON.stringify({
              mediaBase,
              paths: { home: app.getPath("home"), music: safePath("music", "Music"), documents: safePath("documents", "") },
            }),
          ).toString("base64"),
      ],
    },
  });
  win.setMenu(null);

  const sendResized = () => win?.webContents.send("aurora:event", "window://resized", null);
  for (const ev of ["maximize", "unmaximize", "resize", "enter-full-screen", "leave-full-screen"]) win.on(ev, sendResized);

  // Links open in the browser, never inside Aurora.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // The page shows the window once it has drawn; this is the safety net.
  setTimeout(() => {
    if (win && !win.isVisible()) win.show();
  }, 4000);

  win.on("closed", () => (win = null));
  win.loadFile(path.join(__dirname, "app", "index.html"));
}

function safePath(name, fallback) {
  try {
    const p = app.getPath(name);
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return fallback ? path.join(app.getPath("home"), fallback) : app.getPath("home");
}

let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  try {
    core?.socket.end();
  } catch {}
  try {
    coreProc?.kill("SIGTERM");
  } catch {}
});

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on("window-all-closed", () => app.quit());

app.whenReady().then(async () => {
  // Only what Aurora needs from the browser side: no camera, location, etc.
  // "media" only lets the page see the names of speakers/headphones for
  // Settings → Audio output; Aurora never records anything.
  const allowed = (permission) => permission === "media" || permission === "speaker-selection";
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));
  try {
    await startCore();
    const r = await callCore("media_base", {});
    mediaBase = (r.ok && r.data) || "";
  } catch (e) {
    dialog.showErrorBox("Aurora couldn't start", `Aurora's background helper didn't start:\n\n${e instanceof Error ? e.message : e}`);
    app.exit(1);
    return;
  }
  createWindow();
});
