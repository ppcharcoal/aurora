import { invoke } from "@tauri-apps/api/core";
import { normGain } from "./mixmath";
import { native } from "./native";
import { isAndroid } from "./platform";
import { settings } from "./settings.svelte";
import { library } from "./sources/local.svelte";
import type { Track } from "./types";

/**
 * Volume sync (Settings → Playback): every song plays at about the same
 * loudness. Songs are measured once (src-tauri/src/loudness.rs on PCs, the
 * playback service on phones) and then turned up or down while playing.
 * It's a plain multiplier on each song, so transitions (their fades and
 * volume lines) work exactly as before, on top of it. Files aren't changed.
 */
class Loudness {
  /** Bumped when a song's measurement arrives (the player re-applies volumes). */
  version = $state(0);
  /** Background measuring of the library: done / total. */
  progress = $state<{ done: number; total: number } | null>(null);
  private known = new Map<string, { lufs: number; peak: number }>();
  private pending = new Set<string>();
  private queue: string[] = [];
  private running = false;
  private scanning = new Set<string>();
  private started = false;

  get enabled() {
    return settings.value.volumeSync;
  }

  /** Call once at start (after settings and the library). */
  async init() {
    if (this.started) return;
    this.started = true;
    if (isAndroid) {
      this.syncNative();
      return;
    }
    try {
      const all = await invoke<Record<string, { lufs: number; peak: number }>>("loudness_known");
      for (const [p, l] of Object.entries(all)) this.known.set(p, l);
      this.version++;
    } catch {
      /* first run */
    }
    if (this.enabled) this.scanLibrary();
    // New songs (downloads, a rescan) are measured in the background too.
    $effect.root(() => {
      $effect(() => {
        void library.tracks.length;
        if (settings.value.volumeSync) setTimeout(() => this.scanLibrary(), 3000);
      });
    });
  }

  /** The multiplier for a song (1 while it's not measured yet, or when volume sync is off). */
  gainOf(t: Track | null | undefined): number {
    if (!t || !this.enabled || isAndroid) return 1;
    const l = this.known.get(t.path);
    if (l) return normGain(l);
    this.request(t.path, true);
    return 1;
  }

  /** Measure this song soon (first in line when `urgent`). */
  request(path: string, urgent = false) {
    if (isAndroid || this.known.has(path) || this.pending.has(path)) return;
    this.pending.add(path);
    if (urgent) this.queue.unshift(path);
    else this.queue.push(path);
    this.pump();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const path = this.queue.shift()!;
      try {
        const l = await invoke<{ lufs: number; peak: number }>("loudness_measure", { path });
        this.known.set(path, l);
        this.version++;
      } catch {
        /* unreadable: plays unchanged */
      }
      this.pending.delete(path);
      if (this.progress && this.scanning.delete(path)) this.progress = { ...this.progress, done: this.progress.done + 1 };
    }
    this.running = false;
    if (this.progress && !this.scanning.size) this.progress = null;
  }

  /** Measures every song in the library that isn't measured yet, one at a time. */
  scanLibrary() {
    if (isAndroid) return;
    const todo = library.tracks.map((t) => t.path).filter((p) => !this.known.has(p) && !this.pending.has(p));
    if (!todo.length) return;
    for (const p of todo) this.scanning.add(p);
    this.progress = { done: this.progress?.done ?? 0, total: (this.progress?.done ?? 0) + this.scanning.size };
    for (const p of todo) this.request(p);
  }

  /** Settings switch. */
  set(on: boolean) {
    settings.set("volumeSync", on);
    this.version++;
    if (on) this.scanLibrary();
    this.syncNative();
  }

  private syncNative() {
    if (!isAndroid) return;
    native.call("control", { action: "normalize", value: this.enabled ? 1 : 0 }).catch(() => {});
  }
}

export const loudness = new Loudness();
