import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ui } from "./ui.svelte";

export interface ToolsStatus {
  ytdlp: string | null;
  ytdlpVersion: string | null;
  ffmpeg: string | null;
  jsRuntime: string | null;
  ready: boolean;
  canInstall: boolean;
}

/** yt-dlp + FFmpeg + JS runtime, installed into the app's own folder on first use. */
class Tools {
  status = $state<ToolsStatus | null>(null);
  installing = $state(false);
  updating = $state(false);
  progress = $state<{ step: string; done: number; total: number } | null>(null);

  async init() {
    await listen<{ step: string; done: number; total: number }>("tools://progress", (e) => {
      this.progress = e.payload;
    });
    await this.check();
  }

  async check() {
    try {
      this.status = await invoke<ToolsStatus>("tools_status");
    } catch (e) {
      ui.error(e);
    }
  }

  async install() {
    if (this.installing) return;
    this.installing = true;
    this.progress = null;
    try {
      this.status = await invoke<ToolsStatus>("tools_install");
      ui.toast("Download tools are ready", "success");
    } catch (e) {
      ui.error(e);
    } finally {
      this.installing = false;
      this.progress = null;
    }
  }

  async update() {
    this.updating = true;
    try {
      const v = await invoke<string>("tools_update");
      ui.toast(`yt-dlp is up to date (${v})`, "success");
      await this.check();
    } catch (e) {
      ui.error(e);
    } finally {
      this.updating = false;
      this.progress = null;
    }
  }

  /** Makes sure tools exist before a search/download; installs if needed. */
  async ensure(): Promise<boolean> {
    if (!this.status) await this.check();
    if (this.status?.ready) return true;
    if (!this.status?.canInstall) {
      ui.toast("Install yt-dlp, ffmpeg and deno, then restart Aurora.", "error");
      return false;
    }
    await this.install();
    return !!this.status?.ready;
  }
}

export const tools = new Tools();
