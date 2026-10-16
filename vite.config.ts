import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const shim = (name: string) => fileURLToPath(new URL(`./electron/shims/${name}.ts`, import.meta.url));

// https://v2.tauri.app/start/frontend/vite/
// `vite build --mode electron` builds the same app for the Electron Linux
// version: the @tauri-apps packages are swapped for small shims that talk to
// Electron (electron/shims), and the page loads from files (relative base).
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  base: mode === "electron" ? "./" : "/",
  resolve:
    mode === "electron"
      ? {
          alias: [
            { find: /^@tauri-apps\/api\/core$/, replacement: shim("core") },
            { find: /^@tauri-apps\/api\/event$/, replacement: shim("event") },
            { find: /^@tauri-apps\/api\/path$/, replacement: shim("path") },
            { find: /^@tauri-apps\/api\/window$/, replacement: shim("window") },
            { find: /^@tauri-apps\/plugin-dialog$/, replacement: shim("dialog") },
            { find: /^@tauri-apps\/plugin-opener$/, replacement: shim("opener") },
          ],
        }
      : {},
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WebView2 on Windows is evergreen Chromium.
    target: "chrome120",
    sourcemap: false,
    reportCompressedSize: false,
    outDir: mode === "electron" ? "electron/app" : "dist",
    emptyOutDir: true,
  },
}));
