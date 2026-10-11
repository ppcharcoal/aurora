import { LocalEngine } from "./engines/local";
import { profiles } from "./profiles.svelte";
import { settings } from "./settings.svelte";
import { stats } from "./stats.svelte";
import { scrobbleHooks } from "./hooks";
import { debouncedSaver, storeGet } from "./store";
import { library } from "./sources/local.svelte";
import type { Track } from "./types";
import { ui } from "./ui.svelte";
import { native, type NativePlay, type NativeState } from "./native";
import { isAndroid } from "./platform";

export type Repeat = "off" | "all" | "one";

const TICK_MS = 250;

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Player {
  queue = $state.raw<Track[]>([]);
  index = $state(-1);
  playing = $state(false);
  loading = $state(false);
  /** ms, updated ~4×/s while playing (the seek bar animates between ticks). */
  position = $state(0);
  duration = $state(0);
  shuffle = $state(false);
  repeat = $state<Repeat>("off");
  private recentIds = $state.raw<string[]>([]);

  current = $derived(this.index >= 0 ? (this.queue[this.index] ?? null) : null);
  upNext = $derived(this.queue.slice(this.index + 1));
  /** Recently played tracks that still exist in the library. */
  // Two saved ids can lead to the same song (a hidden duplicate copy maps to the kept one): list it once.
  recent = $derived([...new Set(this.recentIds.map((id) => library.byId.get(id)).filter((t): t is Track => !!t))]);

  private engine: LocalEngine;
  private original: Track[] = [];
  private ticker: ReturnType<typeof setInterval> | undefined;
  private errorStreak = 0;
  private lastTick = 0;
  private saveRecent: (v: unknown) => void = () => {};

  constructor() {
    this.engine = new LocalEngine({
      state: (p) => {
        this.playing = p;
        if (p) scrobbleHooks.playing?.();
        if (p) {
          this.loading = false;
          this.errorStreak = 0;
        }
        this.syncTicker();
        this.syncMediaSession();
      },
      ended: () => this.onEnded(),
      error: (msg) => {
        this.loading = false;
        ui.toast(msg, "error");
        if (++this.errorStreak < 5 && this.index < this.queue.length - 1) this.next(true);
      },
      duration: (ms) => {
        if (ms > 0) this.duration = ms;
      },
    });
    if (!isAndroid) this.setupMediaSession();
  }

  /** Recently played list for the active profile. */
  async loadProfile() {
    this.saveRecent = debouncedSaver(profiles.key("recent"), 1000);
    const ids = await storeGet<unknown[]>(profiles.key("recent"));
    this.recentIds = (ids ?? []).filter((x): x is string => typeof x === "string");
  }

  /* ------------------------------ queue ------------------------------ */

  playList(tracks: Track[], start = 0) {
    if (!tracks.length) return;
    this.original = tracks;
    if (this.shuffle) {
      const first = tracks[start];
      this.queue = [first, ...shuffled(tracks.filter((_, i) => i !== start))];
      start = 0;
    } else {
      this.queue = tracks;
    }
    if (isAndroid) this.sendQueue(start);
    else this.load(start);
  }

  shuffleAll(tracks: Track[]) {
    if (!tracks.length) return;
    if (!this.shuffle) this.shuffle = true;
    this.playList(tracks, Math.floor(Math.random() * tracks.length));
  }

  playNext(t: Track) {
    const q = [...this.queue];
    q.splice(this.index + 1, 0, t);
    this.queue = q;
    if (this.index < 0) this.start(0);
    else {
      this.syncNative();
      ui.toast(`“${t.title}” will play next`, "success", 2200);
    }
  }

  addToQueue(t: Track, quiet = false) {
    if (quiet && this.queue.some((q, i) => i > this.index && q.key === t.key)) return;
    this.queue = [...this.queue, t];
    if (this.index < 0) this.start(0);
    else {
      this.syncNative();
      if (!quiet) ui.toast(`Added “${t.title}” to the queue`, "success", 2200);
    }
  }

  removeAt(i: number) {
    if (i === this.index) return;
    const q = [...this.queue];
    q.splice(i, 1);
    this.queue = q;
    if (i < this.index) this.index--;
    this.syncNative();
  }

  jumpTo(i: number) {
    this.load(i);
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const cur = this.current;
    if (!cur) return;
    if (this.shuffle) {
      this.original = this.queue;
      this.queue = [cur, ...shuffled(this.queue.filter((_, i) => i !== this.index))];
      this.index = 0;
    } else if (this.original.length) {
      this.queue = this.original;
      this.index = Math.max(0, this.original.findIndex((t) => t.key === cur.key));
    }
    this.syncNative();
  }

  cycleRepeat() {
    this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
    if (isAndroid) native.call("control", { action: "repeat", value: ["off", "all", "one"].indexOf(this.repeat) }).catch(ui.error);
  }

  /* ---------------------------- transport ---------------------------- */

  /** Starts the current queue at `i` (sends it to the Android player first). */
  private start(i: number) {
    if (isAndroid) this.sendQueue(i);
    else this.load(i);
  }

  private async load(i: number) {
    const track = this.queue[i];
    if (!track) return;
    if (isAndroid) {
      // The queue is already on the Android side; just jump.
      this.index = i;
      this.position = 0;
      this.loading = true;
      native.call("control", { action: "jump", value: i }).catch(ui.error);
      return;
    }
    this.index = i;
    this.position = 0;
    this.duration = track.durationMs;
    this.loading = true;
    stats.newPlay();
    scrobbleHooks.start?.(track);
    this.pushRecent(track);
    this.syncMediaSession();
    try {
      this.engine.setVolume(settings.value.volume);
      await this.engine.load(track, true);
    } catch (e) {
      this.loading = false;
      this.playing = false;
      // Autoplay interruptions when skipping quickly are harmless.
      if (!(e instanceof DOMException && e.name === "AbortError")) ui.error(e);
    }
  }

  async toggle() {
    if (!this.current) {
      if (this.queue.length) this.load(Math.max(0, this.index));
      return;
    }
    try {
      if (isAndroid) await native.call("control", { action: this.playing ? "pause" : "play" });
      else if (this.playing) await this.engine.pause();
      else await this.engine.play();
    } catch (e) {
      ui.error(e);
    }
  }

  next(auto = false) {
    if (!this.queue.length) return;
    let i = this.index + 1;
    if (i >= this.queue.length) {
      if (this.repeat === "all" || !auto) i = 0;
      else {
        this.playing = false;
        this.syncTicker();
        return;
      }
    }
    this.load(i);
  }

  prev() {
    if ((isAndroid ? this.position : this.engine.position()) > 3000) {
      this.seek(0);
      return;
    }
    this.load(Math.max(0, this.index - 1));
  }

  seek(ms: number) {
    this.position = ms;
    this.nativeAt = performance.now();
    if (isAndroid) native.call("control", { action: "seek", value: ms }).catch(ui.error);
    else this.engine.seek(ms).catch(ui.error);
  }

  setVolume(v: number) {
    settings.set("volume", v);
    if (isAndroid) native.call("control", { action: "volume", value: v * v }).catch(() => {});
    else this.engine.setVolume(v);
  }

  private onEnded() {
    if (this.repeat === "one") this.load(this.index);
    else this.next(true);
  }

  /* ------------------------------ ticker ----------------------------- */

  private syncTicker() {
    clearInterval(this.ticker);
    this.lastTick = performance.now();
    if (isAndroid) {
      // The Android player reports every second; move the seek bar smoothly in between.
      // Listening time and scrobbles come from its log (collectPlays).
      if (this.playing && !this.loading) {
        this.ticker = setInterval(() => {
          const ms = this.nativePosition + (performance.now() - this.nativeAt);
          this.position = this.duration ? Math.min(ms, this.duration) : ms;
        }, TICK_MS);
      }
      return;
    }
    if (this.playing) {
      this.ticker = setInterval(() => {
        this.position = this.engine.position();
        // Count real listening time for the profile's stats.
        const now = performance.now();
        if (this.current) {
          stats.record(this.current, now - this.lastTick);
          scrobbleHooks.listen?.(this.current, now - this.lastTick);
        }
        this.lastTick = now;
      }, TICK_MS);
    }
    this.position = this.engine.position();
  }

  /* ----------------------------- Android ----------------------------- */

  private nativePosition = 0;
  private nativeAt = 0;
  private nativeError = "";

  private items() {
    return this.queue.map((t) => ({ id: t.id, path: t.path, title: t.title, artist: t.artist, album: t.album ?? null }));
  }

  /** Hands a new queue to the Android player and starts it at `i`. */
  private sendQueue(i: number) {
    const track = this.queue[i];
    if (!track) return;
    this.index = i;
    this.position = 0;
    this.duration = track.durationMs;
    this.loading = true;
    native.call("queue", { items: this.items(), index: i, positionMs: 0, play: true, keep: false }).catch(ui.error);
  }

  /** The queue changed around the current song: update the Android player without interrupting it. */
  private syncNative() {
    if (!isAndroid || this.index < 0) return;
    native.call("queue", { items: this.items(), index: this.index, positionMs: 0, play: this.playing, keep: true }).catch(ui.error);
  }

  /** Android: connect to the playback service. Call once the library is loaded (ids → songs). */
  startNative() {
    if (!isAndroid || this.nativeStarted) return;
    this.nativeStarted = true;
    native.on<NativeState>("state", (s) => this.onNative(s)).catch(() => {});
    // Pick up whatever is already playing (e.g. started from the car).
    const first = () => native.call<NativeState>("state").then((s) => this.onNative(s));
    first().catch(() => {});
    // Listening done while the app wasn't open counts too.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        first().catch(() => {});
        this.collectPlays();
      }
    });
    setInterval(() => this.collectPlays(), 20_000);
    setTimeout(() => this.collectPlays(), 3000);
  }

  private onNative(s: NativeState) {
    if (s.ids) {
      const ids = s.ids;
      const resolved = ids.map((id) => library.byId.get(id));
      const tracks = resolved.filter((t): t is Track => !!t);
      // Position of the current song among the songs we could resolve (ids may be old copies' ids).
      const at = s.index >= 0 && resolved[s.index] ? resolved.slice(0, s.index).filter(Boolean).length : -1;
      // Only adopt the player's list when it differs from ours (e.g. Android Auto started an album).
      const same = tracks.length === this.queue.length && tracks.every((t, i) => t.id === this.queue[i]?.id);
      if (!same) {
        this.queue = tracks;
        this.original = tracks;
      }
      this.index = at;
    } else if (s.index >= 0) {
      this.index = Math.min(s.index, this.queue.length - 1);
    }
    const prev = this.lastStarted;
    const t = this.current;
    if (t && t.key !== prev) {
      this.lastStarted = t.key;
      this.pushRecent(t);
      scrobbleHooks.start?.(t); // "now playing" on Last.fm
    }
    this.playing = s.playing;
    this.loading = s.loading;
    if (s.repeat) this.repeat = s.repeat;
    if (s.playing) scrobbleHooks.playing?.();
    this.nativePosition = s.positionMs;
    this.nativeAt = performance.now();
    this.position = s.positionMs;
    if (s.durationMs > 0) this.duration = s.durationMs;
    if (s.error && s.error !== this.nativeError && !s.playing) ui.toast(s.error, "error");
    this.nativeError = s.error ?? "";
    this.syncTicker();
  }

  private lastStarted = "";
  private nativeStarted = false;
  private collecting = false;

  /** Adds the Android player's finished plays to stats and Last.fm. */
  private async collectPlays() {
    if (this.collecting) return;
    this.collecting = true;
    try {
      const r = await native.call<{ plays: NativePlay[] }>("plays");
      for (const p of r.plays ?? []) {
        const t = library.byId.get(p.id);
        if (!t) continue;
        stats.addPlay(t, p.listenedMs, p.startedAt);
        scrobbleHooks.logged?.(t, p.listenedMs, p.startedAt, p.durationMs ?? 0);
      }
    } catch {
      // Not ready yet; next time.
    } finally {
      this.collecting = false;
    }
  }

  /* --------------------------- recent / OS --------------------------- */

  private pushRecent(t: Track) {
    this.recentIds = [t.id, ...this.recentIds.filter((r) => r !== t.id)].slice(0, 24);
    this.saveRecent(this.recentIds);
  }

  /** Windows media overlay + hardware media keys. */
  private setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.setActionHandler("play", () => this.toggle());
    ms.setActionHandler("pause", () => this.toggle());
    ms.setActionHandler("nexttrack", () => this.next());
    ms.setActionHandler("previoustrack", () => this.prev());
    ms.setActionHandler("seekto", (d) => d.seekTime != null && this.seek(d.seekTime * 1000));
  }

  private syncMediaSession() {
    const ms = navigator.mediaSession;
    const t = this.current;
    if (!ms || !t) return;
    ms.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album ?? "",
      artwork: t.art ? [{ src: t.art, sizes: "320x320", type: "image/jpeg" }] : [],
    });
    ms.playbackState = this.playing ? "playing" : "paused";
  }
}

export const player = new Player();
