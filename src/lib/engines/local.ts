import { mediaSrc } from "../media";
import { output } from "../output.svelte";
import { spectrum } from "../spectrum";
import { fxA, fxB, gainA, gainB, hasFx, mixEnd, type Mix } from "../transitions.svelte";
import { graph, NEUTRAL } from "../audiograph";
import type { Track } from "../types";

export interface EngineEvents {
  state(playing: boolean): void;
  ended(): void;
  error(message: string): void;
  duration?(ms: number): void;
  /** A transition started: the next song is now the one playing. */
  mixed?(): void;
}

const FADE_MS = 140;
const TICK_MS = 40;
/** Start loading the next song this long before its transition. */
const PRELOAD_MS = 12000;

interface Running {
  out: HTMLAudioElement;
  inc: HTMLAudioElement;
  mix: Mix;
  outDone: boolean;
}

/**
 * Plays local files through the web view's media pipeline (hardware decoding,
 * low CPU). Two "decks" (audio elements): one plays, the other gets the next
 * song ready, so a transition can overlap the end of one song with the start
 * of the next, with volume fades on both.
 */
export class LocalEngine {
  private decks = [new Audio(), new Audio()];
  private cur = 0;
  private volume = 0.8;
  private fadeRaf = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The transition into the next song, if one is planned. */
  private next: { track: Track; mix: Mix } | null = null;
  private preloaded: string | null = null;
  private running: Running | null = null;

  constructor(private ev: EngineEvents) {
    for (const a of this.decks) this.setup(a);
  }

  private get a() {
    return this.decks[this.cur];
  }
  private get b() {
    return this.decks[1 - this.cur];
  }

  private setup(a: HTMLAudioElement) {
    const ev = this.ev;
    a.preload = "auto";
    // CORS mode, so the visualizer may read the sound (Aurora's file server allows it).
    a.crossOrigin = "anonymous";
    output.attach(a);
    spectrum.register(a);
    // Only the deck that's playing "the" song reports; the one fading out stays quiet.
    a.addEventListener("playing", () => a === this.a && ev.state(true));
    a.addEventListener("pause", () => {
      if (a === this.a && !this.switching) ev.state(false);
    });
    a.addEventListener("ended", () => {
      if (a === this.a) ev.ended();
      else if (this.running?.out === a) this.running.outDone = true;
    });
    a.addEventListener("loadedmetadata", () => {
      if (a === this.a && Number.isFinite(a.duration)) ev.duration?.(a.duration * 1000);
    });
    a.addEventListener("error", async () => {
      const src = a.getAttribute("src");
      if (!src) return;
      // Safety net: if a file only failed because of CORS mode, play it without
      // (the visualizer then can't read it). A missing file still answers, so it's reported.
      if (a.crossOrigin && !graph.has(a)) {
        const corsFailed = await fetch(src, { method: "HEAD" }).then(
          () => false,
          () => true,
        );
        if (corsFailed) {
          const at = a.currentTime;
          a.removeAttribute("crossorigin");
          spectrum.corsBroken();
          a.src = src;
          a.currentTime = at;
          if (a === this.a) a.play().catch(() => {});
          return;
        }
      }
      if (a === this.a) ev.error("Couldn't play this file — it may have been moved, or its format isn't supported.");
      else if (this.preloaded) this.preloaded = null; // try again (or skip the transition) when it's time
    });
  }

  /* --------------------------------------------------------- volume -- */

  /** Perceptual (quadratic) volume curve feels much more natural than linear. */
  private applied(v: number) {
    return Math.min(1, Math.max(0, v * v));
  }

  private applyVolumes() {
    const base = this.applied(this.volume);
    const r = this.running;
    if (!r) {
      graph.setVolume(this.a, base);
      return;
    }
    const bT = r.mix.bStart + (r.inc.currentTime * 1000 - r.mix.bOffset);
    if (!r.outDone) graph.setVolume(r.out, Math.min(1, base * gainA(r.mix, r.out.currentTime * 1000)));
    graph.setVolume(r.inc, Math.min(1, base * gainB(r.mix, bT)));
  }

  private fade(to: number): Promise<void> {
    cancelAnimationFrame(this.fadeRaf);
    this.fadeRaf = 0;
    const a = this.a;
    const from = graph.volumeOf(a);
    const start = performance.now();
    return new Promise((resolve) => {
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / FADE_MS);
        graph.setVolume(a, from + (to - from) * k);
        if (k < 1) this.fadeRaf = requestAnimationFrame(step);
        else {
          this.fadeRaf = 0;
          resolve();
        }
      };
      this.fadeRaf = requestAnimationFrame(step);
    });
  }

  /* ------------------------------------------------------ transitions -- */

  private switching = false;

  /** The next song and how to go into it (null: one after the other). */
  schedule(track: Track | null, mix: Mix | null) {
    this.next = track && mix ? { track, mix } : null;
    if (this.preloaded && this.preloaded !== this.next?.track.path) this.clearDeck(this.b);
    this.syncTimer();
  }

  /** A transition is under way. */
  get mixing() {
    return !!this.running;
  }

  private clearDeck(d: HTMLAudioElement) {
    if (this.running && (d === this.running.out || d === this.running.inc)) return;
    d.pause();
    if (d.getAttribute("src")) {
      d.removeAttribute("src");
      d.load();
    }
    if (d === this.b) this.preloaded = null;
  }

  private syncTimer() {
    const need = !!this.running || (!!this.next && !this.a.paused);
    if (need && !this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
    if (!need && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private tick() {
    if (this.running) return this.step();
    const n = this.next;
    const a = this.a;
    if (!n || a.paused) return this.syncTimer();
    const t = a.currentTime * 1000;
    // Effects and volume points drawn before B comes in (custom transitions) shape A already.
    if (hasFx(n.mix.aFx)) graph.setFx(a, fxA(n.mix, t));
    if (n.mix.aPoints?.length && !this.fadeRaf) graph.setVolume(a, Math.min(1, this.applied(this.volume) * gainA(n.mix, t)));
    if (this.preloaded !== n.track.path && t >= n.mix.bStart - PRELOAD_MS) {
      const b = this.b;
      b.pause();
      graph.setVolume(b, 0);
      b.src = mediaSrc(n.track.path);
      b.currentTime = n.mix.bOffset / 1000;
      b.load();
      this.preloaded = n.track.path;
    }
    if (t >= n.mix.bStart) this.start(t);
  }

  private start(t: number) {
    const n = this.next!;
    const out = this.a;
    const inc = this.b;
    if (this.preloaded !== n.track.path) inc.src = mediaSrc(n.track.path);
    graph.setVolume(inc, 0);
    inc.muted = out.muted;
    inc.currentTime = (n.mix.bOffset + Math.max(0, t - n.mix.bStart)) / 1000;
    this.running = { out, inc, mix: n.mix, outDone: false };
    this.next = null;
    this.preloaded = null;
    this.cur = 1 - this.cur;
    inc.play().catch(() => this.ev.error("Couldn't play the next song."));
    this.ev.mixed?.();
    this.step();
  }

  private step() {
    const r = this.running!;
    this.applyVolumes();
    const aT = r.out.currentTime * 1000;
    if (hasFx(r.mix.aFx) && !r.outDone) graph.setFx(r.out, fxA(r.mix, aT));
    if (hasFx(r.mix.bFx)) graph.setFx(r.inc, fxB(r.mix, r.mix.bStart + (r.inc.currentTime * 1000 - r.mix.bOffset)));
    if (!r.outDone && (aT >= r.mix.aEnd || r.out.ended)) {
      r.outDone = true;
      r.out.pause();
    }
    const bT = r.mix.bStart + (r.inc.currentTime * 1000 - r.mix.bOffset);
    if (r.outDone && bT >= mixEnd(r.mix)) this.finish();
  }

  /** Ends a transition now (song changed, seek…): the incoming song carries on alone. */
  private finish() {
    const r = this.running;
    if (!r) return;
    this.running = null;
    r.out.pause();
    graph.setFx(r.out, NEUTRAL);
    graph.setFx(r.inc, NEUTRAL);
    this.clearDeck(r.out);
    this.applyVolumes();
    this.syncTimer();
  }

  /* -------------------------------------------------------- transport -- */

  async load(track: Track, autoplay: boolean) {
    cancelAnimationFrame(this.fadeRaf);
    this.fadeRaf = 0;
    this.finish();
    this.next = null;
    this.switching = true;
    this.clearDeck(this.b);
    const a = this.a;
    for (const d of this.decks) graph.setFx(d, NEUTRAL);
    a.src = mediaSrc(track.path);
    graph.setVolume(a, this.applied(this.volume));
    this.switching = false;
    if (autoplay) await a.play();
    this.syncTimer();
  }

  async play() {
    if (this.running) {
      if (!this.running.outDone) this.running.out.play().catch(() => {});
      await this.a.play();
      this.syncTimer();
      return;
    }
    graph.setVolume(this.a, 0);
    await this.a.play();
    this.syncTimer();
    await this.fade(this.applied(this.volume));
  }

  async pause() {
    if (this.running) {
      this.running.out.pause();
      this.a.pause();
      return;
    }
    await this.fade(0);
    this.a.pause();
    this.syncTimer();
  }

  async seek(ms: number) {
    this.finish();
    this.a.currentTime = ms / 1000;
    this.syncTimer();
  }

  setVolume(v: number) {
    this.volume = v;
    cancelAnimationFrame(this.fadeRaf);
    this.fadeRaf = 0;
    this.applyVolumes();
  }

  /** Mutes this computer's output only; the visualizer still sees the music. */
  setMuted(muted: boolean) {
    graph.setMuted(muted, this.decks);
  }

  position() {
    return this.a.currentTime * 1000;
  }
}
