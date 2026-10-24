import { invoke } from "@tauri-apps/api/core";
import { native } from "./native";
import { isAndroid } from "./platform";
import { profiles } from "./profiles.svelte";
import { debouncedSaver, storeGet } from "./store";
import type { Track } from "./types";

/**
 * Transitions between songs, like a DJ mix: when song B follows song A, B can
 * start before A has ended, with A fading out and B fading in.
 *
 * Nothing here touches the music files: a transition is only a few numbers
 * saved in Aurora's data (per profile), applied while playing. The files play
 * normally everywhere else.
 *
 *  - None: one song after the other, as recorded.
 *  - Smooth: skips silence at the end of A and the start of B and crossfades
 *    them (desktop). On phones it fades out and back in (no overlap).
 *  - Custom (desktop): made in the transition editor for one pair of songs.
 */

export * from "./mixmath";
import { clampMix, type Mix } from "./mixmath";

export type PairMode = "none" | "smooth" | "custom";
export interface PairSetting {
  mode: PairMode;
  mix?: Mix;
}

interface Data {
  /** What plays between songs unless a pair has its own transition. */
  mode: "none" | "smooth";
  /** Length of the Smooth crossfade. */
  smoothMs: number;
  /** "<idA>><idB>" → setting for that pair. */
  pairs: Record<string, PairSetting>;
}

const defaults: Data = { mode: "none", smoothMs: 6000, pairs: {} };

export const pairKey = (a: Track, b: Track) => `${a.id}>${b.id}`;

export interface Bounds {
  leadMs: number;
  endMs: number;
}

class Transitions {
  value = $state<Data>({ ...defaults, pairs: {} });
  /** Bumped on every change, so the player re-plans what's next. */
  version = $state(0);
  private save: (v: unknown) => void = () => {};
  private bounds = new Map<string, Promise<Bounds | null>>();
  private known = new Map<string, Bounds>();

  async load() {
    this.save = debouncedSaver(profiles.key("transitions"));
    const saved = await storeGet<Partial<Data>>(profiles.key("transitions"));
    this.value = { ...defaults, ...(saved ?? {}), pairs: { ...(saved?.pairs ?? {}) } };
    this.version++;
    this.syncNative();
  }

  private changed() {
    this.save($state.snapshot(this.value));
    this.version++;
  }

  setMode(mode: Data["mode"]) {
    this.value.mode = mode;
    this.changed();
    this.syncNative();
  }

  setSmoothMs(ms: number) {
    this.value.smoothMs = Math.round(Math.min(12000, Math.max(1000, ms)));
    this.changed();
    this.syncNative();
  }

  /** The pair's own setting, or null when it follows the default. */
  pair(a: Track, b: Track): PairSetting | null {
    return this.value.pairs[pairKey(a, b)] ?? null;
  }

  setPair(a: Track, b: Track, s: PairSetting | null) {
    const k = pairKey(a, b);
    if (s) this.value.pairs[k] = s;
    else delete this.value.pairs[k];
    this.changed();
    this.syncNative();
  }

  /** What A → B uses: its own setting or the default. */
  modeFor(a: Track, b: Track): PairMode {
    const p = this.pair(a, b);
    return p?.mode ?? this.value.mode;
  }

  /** Where the music really starts and ends (silence trimmed); cached. Desktop only. */
  boundsOf(t: Track): Promise<Bounds | null> {
    let p = this.bounds.get(t.path);
    if (!p) {
      const args = { path: t.path, durationMs: Math.round(t.durationMs) };
      // Phones read songs with Android's own decoders; PCs with FFmpeg.
      p = (isAndroid ? native.call<Bounds>("bounds", args) : invoke<Bounds>("audio_bounds", args))
        .then((b) => {
          this.known.set(t.path, b);
          return b;
        })
        .catch(() => null);
      this.bounds.set(t.path, p);
    }
    return p;
  }

  /** Loudness outline of part of a song (0–255 values), for the editor's waveforms. */
  async peaksOf(path: string, startMs: number, durMs: number, points: number): Promise<number[]> {
    if (isAndroid) return (await native.call<{ peaks: number[] }>("peaks", { path, startMs, durMs, points })).peaks;
    return invoke<number[]>("audio_peaks", { path, startMs, durMs, points });
  }

  smoothMix(a: Track, b: Track, ba?: Bounds | null, bb?: Bounds | null): Mix {
    const aEnd = ba?.endMs ?? a.durationMs;
    const bOffset = bb?.leadMs ?? 0;
    const len = Math.max(0, Math.min(this.value.smoothMs, aEnd / 3, (b.durationMs - bOffset) / 3));
    return { bStart: aEnd - len, aEnd, bOffset, fadeOut: len, fadeIn: len, aGain: 1, bGain: 1, curve: "smooth" };
  }

  /** The mix for A → B right now (Smooth without trimming if the songs aren't analysed yet). */
  planNow(a: Track, b: Track): Mix | null {
    const mode = this.modeFor(a, b);
    if (mode === "none" || isAndroid) return null;
    if (mode === "custom") {
      const m = this.pair(a, b)?.mix;
      return m ? clampMix(m, a.durationMs, b.durationMs) : null;
    }
    return this.smoothMix(a, b, this.known.get(a.path), this.known.get(b.path));
  }

  /** Same, after analysing the songs for Smooth. */
  async plan(a: Track, b: Track): Promise<Mix | null> {
    if (isAndroid || this.modeFor(a, b) !== "smooth") return this.planNow(a, b);
    const [ba, bb] = await Promise.all([this.boundsOf(a), this.boundsOf(b)]);
    return this.smoothMix(a, b, ba, bb);
  }

  /** Phones: the playback service does the fades itself. */
  private syncNative() {
    if (!isAndroid) return;
    native.call("control", { action: "transition", value: this.value.mode === "smooth" ? this.value.smoothMs : 0 }).catch(() => {});
  }
}

export const transitions = new Transitions();
