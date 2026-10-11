import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { player } from "./player.svelte";
import { settings } from "./settings.svelte";
import { ui } from "./ui.svelte";
import { scrobbleHooks } from "./hooks";
import { output } from "./output.svelte";

/**
 * Listen before downloading. Catalog songs use their 30-second clip; YouTube
 * and SoundCloud results stream straight from the site (via yt-dlp).
 * One preview at a time; it pauses the main player and stops when that resumes.
 */
class Preview {
  key = $state<string | null>(null);
  loading = $state(false);
  playing = $state(false);
  progress = $state(0);
  private audio: HTMLAudioElement | null = null;
  private queue: { key: string; src: () => Promise<string> }[] = [];
  private seq = 0;

  private el() {
    if (!this.audio) {
      const a = new Audio();
      output.attach(a);
      a.addEventListener("timeupdate", () => {
        this.progress = a.duration ? a.currentTime / a.duration : 0;
      });
      a.addEventListener("playing", () => {
        this.playing = true;
        this.loading = false;
      });
      a.addEventListener("pause", () => (this.playing = false));
      a.addEventListener("ended", () => this.next());
      a.addEventListener("error", () => {
        if (!a.getAttribute("src")) return;
        ui.toast("This preview couldn't be played.", "error");
        this.next();
      });
      this.audio = a;
    }
    return this.audio;
  }

  /** `src` can be a direct URL, or a site id/URL that yt-dlp resolves. */
  static source(src: { preview?: string | null; id?: string; streamable?: boolean }): (() => Promise<string>) | null {
    if (src.preview) return () => Promise.resolve(src.preview!);
    if (src.id && src.streamable) return () => invoke<string>("yt_stream_url", { id: src.id });
    return null;
  }

  toggle(key: string, src: () => Promise<string>) {
    if (this.key === key) this.stop();
    else this.playList([{ key, src }]);
  }

  /** Plays several previews in a row (e.g. a whole album). */
  async playList(items: { key: string; src: () => Promise<string> }[]) {
    this.queue = items.slice(1);
    const first = items[0];
    if (!first) return;
    const mine = ++this.seq;
    if (player.playing) player.toggle();
    this.key = first.key;
    this.loading = true;
    this.progress = 0;
    try {
      const url = await first.src();
      if (mine !== this.seq) return;
      const a = this.el();
      a.volume = Math.min(1, settings.value.volume ** 2);
      // Local clip (saved by yt_stream_url) or a direct stream.
      a.src = url.startsWith("http") ? url : convertFileSrc(url);
      await a.play();
    } catch (e) {
      if (mine !== this.seq) return;
      this.loading = false;
      ui.error(e);
      this.next();
    }
  }

  private next() {
    const rest = this.queue;
    if (rest.length) this.playList(rest);
    else this.stop();
  }

  stop() {
    this.seq++;
    this.queue = [];
    this.key = null;
    this.loading = false;
    this.playing = false;
    this.progress = 0;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
  }
}

export const preview = new Preview();
export const previewSource = Preview.source;

scrobbleHooks.playing = () => {
  if (preview.key) preview.stop();
};
