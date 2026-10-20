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

export type Curve = "linear" | "smooth";

/** One transition from A into B. Times are in ms; `bStart`/`aEnd` on A's timeline, `bOffset` on B's. */
export interface Mix {
  /** When B starts, in A. */
  bStart: number;
  /** Where A stops (it has faded out by then). */
  aEnd: number;
  /** Where in B playback starts (skips B's intro). */
  bOffset: number;
  /** A fades out over this long, ending at aEnd. */
  fadeOut: number;
  /** B fades in over this long, from bStart. */
  fadeIn: number;
  /** Volumes during the overlap, 0–1. */
  aGain: number;
  bGain: number;
  curve: Curve;
}

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

/** 0→1 shape of a fade. "smooth" keeps the loudness even across a crossfade (equal power). */
export function shape(x: number, curve: Curve) {
  const v = Math.min(1, Math.max(0, x));
  return curve === "smooth" ? Math.sin((v * Math.PI) / 2) : v;
}

const SETTLE_MS = 1500;

/** Volume of A at A-time `t`. */
export function gainA(m: Mix, t: number) {
  if (t >= m.aEnd) return 0;
  let g = t < m.bStart ? 1 : 1 + (m.aGain - 1) * Math.min(1, (t - m.bStart) / 400);
  if (m.fadeOut > 0 && t > m.aEnd - m.fadeOut) g *= shape((m.aEnd - t) / m.fadeOut, m.curve);
  return g;
}

/** Volume of B at A-time `t` (B's own time is t − bStart + bOffset). */
export function gainB(m: Mix, t: number) {
  if (t < m.bStart) return 0;
  const inG = m.fadeIn > 0 ? shape((t - m.bStart) / m.fadeIn, m.curve) : 1;
  const end = Math.max(m.aEnd, m.bStart + m.fadeIn);
  const level = t <= end ? m.bGain : m.bGain + (1 - m.bGain) * Math.min(1, (t - end) / SETTLE_MS);
  return inG * level;
}

/** When the transition is completely over, on A's timeline. */
export const mixEnd = (m: Mix) => Math.max(m.aEnd, m.bStart + m.fadeIn) + (m.bGain < 1 ? SETTLE_MS : 0);

/** Keeps a mix possible for these two songs. */
export function clampMix(m: Mix, aDur: number, bDur: number): Mix {
  const aEnd = Math.min(Math.max(m.aEnd, 1000), aDur || m.aEnd);
  const bStart = Math.min(Math.max(0, m.bStart), aEnd);
  const bOffset = Math.min(Math.max(0, m.bOffset), Math.max(0, (bDur || m.bOffset + 1000) - 1000));
  return {
    bStart,
    aEnd,
    bOffset,
    fadeOut: Math.min(Math.max(0, m.fadeOut), aEnd),
    fadeIn: Math.min(Math.max(0, m.fadeIn), Math.max(0, (bDur || 60000) - bOffset)),
    aGain: Math.min(1, Math.max(0, m.aGain)),
    bGain: Math.min(1, Math.max(0, m.bGain)),
    curve: m.curve === "linear" ? "linear" : "smooth",
  };
}

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
  }

  /** What A → B uses: its own setting or the default. */
  modeFor(a: Track, b: Track): PairMode {
    const p = this.pair(a, b);
    if (isAndroid) return this.value.mode; // phones: presets only
    return p?.mode ?? this.value.mode;
  }

  /** Where the music really starts and ends (silence trimmed); cached. Desktop only. */
  boundsOf(t: Track): Promise<Bounds | null> {
    let p = this.bounds.get(t.path);
    if (!p) {
      p = invoke<Bounds>("audio_bounds", { path: t.path, durationMs: Math.round(t.durationMs) })
        .then((b) => {
          this.known.set(t.path, b);
          return b;
        })
        .catch(() => null);
      this.bounds.set(t.path, p);
    }
    return p;
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
