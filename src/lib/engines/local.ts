import { convertFileSrc } from "@tauri-apps/api/core";
import { output } from "../output.svelte";
import type { Track } from "../types";

export interface EngineEvents {
  state(playing: boolean): void;
  ended(): void;
  error(message: string): void;
  duration?(ms: number): void;
}

const FADE_MS = 140;

/** Plays local files through WebView2's native media pipeline (hardware decoding, low CPU). */
export class LocalEngine {
  private audio = new Audio();
  private volume = 0.8;
  private fadeRaf = 0;

  constructor(private ev: EngineEvents) {
    const a = this.audio;
    a.preload = "auto";
    output.attach(a);
    a.addEventListener("playing", () => ev.state(true));
    a.addEventListener("pause", () => ev.state(false));
    a.addEventListener("ended", () => ev.ended());
    a.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(a.duration)) ev.duration?.(a.duration * 1000);
    });
    a.addEventListener("error", () => {
      if (!a.getAttribute("src")) return;
      ev.error("Couldn't play this file — it may have been moved, or its format isn't supported.");
    });
  }

  /** Perceptual (quadratic) volume curve feels much more natural than linear. */
  private applied(v: number) {
    return Math.min(1, Math.max(0, v * v));
  }

  private fade(to: number): Promise<void> {
    cancelAnimationFrame(this.fadeRaf);
    const from = this.audio.volume;
    const start = performance.now();
    return new Promise((resolve) => {
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / FADE_MS);
        this.audio.volume = from + (to - from) * k;
        if (k < 1) this.fadeRaf = requestAnimationFrame(step);
        else resolve();
      };
      this.fadeRaf = requestAnimationFrame(step);
    });
  }

  async load(track: Track, autoplay: boolean) {
    cancelAnimationFrame(this.fadeRaf);
    this.audio.src = convertFileSrc(track.path);
    this.audio.volume = this.applied(this.volume);
    if (autoplay) await this.audio.play();
  }

  async play() {
    this.audio.volume = 0;
    await this.audio.play();
    await this.fade(this.applied(this.volume));
  }

  async pause() {
    await this.fade(0);
    this.audio.pause();
  }

  async seek(ms: number) {
    this.audio.currentTime = ms / 1000;
  }

  setVolume(v: number) {
    this.volume = v;
    cancelAnimationFrame(this.fadeRaf);
    this.audio.volume = this.applied(v);
  }

  position() {
    return this.audio.currentTime * 1000;
  }
}
