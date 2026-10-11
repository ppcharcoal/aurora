import { profiles } from "./profiles.svelte";
import { debouncedSaver, storeGet } from "./store";
import type { Track } from "./types";

/** Listening time is real playback time (paused or seeking doesn't count). */
export interface Stats {
  totalMs: number;
  /** "YYYY-MM-DD" (local) → ms */
  days: Record<string, number>;
  /** track id → ms */
  tracks: Record<string, number>;
  /** artist → ms */
  artists: Record<string, number>;
  /** track id → times played for at least 30 s */
  plays: Record<string, number>;
  since: number;
}

const empty = (): Stats => ({ totalMs: 0, days: {}, tracks: {}, artists: {}, plays: {}, since: Date.now() });

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const PLAY_THRESHOLD = 30_000;

class StatsStore {
  // Raw state: updated several times a second, so avoid deep proxies.
  value = $state.raw<Stats>(empty());
  private save: (v: unknown) => void = () => {};
  /** Listened ms of the current play, to count a "play" once it passes 30 s. */
  private current = { key: "", ms: 0, counted: false };

  async load() {
    this.save = debouncedSaver(profiles.key("stats"), 5000);
    this.value = { ...empty(), ...((await storeGet<Stats>(profiles.key("stats"))) ?? {}) };
  }

  /** Called by the player with the real time that just played. */
  record(t: Track, ms: number) {
    if (ms <= 0 || ms > 5000) return; // ignore gaps (sleep, stalls)
    // The maps are mutated in place (cheap); the shallow copy tells the UI to update.
    const v = this.value;
    const day = dayKey();
    v.days[day] = (v.days[day] ?? 0) + ms;
    v.tracks[t.id] = (v.tracks[t.id] ?? 0) + ms;
    v.artists[t.artist] = (v.artists[t.artist] ?? 0) + ms;
    if (this.current.key !== t.key) this.current = { key: t.key, ms: 0, counted: false };
    this.current.ms += ms;
    if (!this.current.counted && this.current.ms >= PLAY_THRESHOLD) {
      this.current.counted = true;
      v.plays[t.id] = (v.plays[t.id] ?? 0) + 1;
    }
    const next = { ...v, totalMs: v.totalMs + ms };
    this.value = next;
    this.save(next);
  }

  /** A whole play logged by the Android playback service (e.g. in the car). */
  addPlay(t: Track, ms: number, startedAt: number) {
    if (ms <= 0) return;
    const v = this.value;
    const day = dayKey(new Date(startedAt * 1000));
    v.days[day] = (v.days[day] ?? 0) + ms;
    v.tracks[t.id] = (v.tracks[t.id] ?? 0) + ms;
    v.artists[t.artist] = (v.artists[t.artist] ?? 0) + ms;
    if (ms >= PLAY_THRESHOLD) v.plays[t.id] = (v.plays[t.id] ?? 0) + 1;
    const next = { ...v, totalMs: v.totalMs + ms };
    this.value = next;
    this.save(next);
  }

  /** A new play of the same song starts its own 30 s count. */
  newPlay() {
    this.current = { key: "", ms: 0, counted: false };
  }
}

export const stats = new StatsStore();
