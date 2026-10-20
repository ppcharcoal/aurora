import type { PluginListener } from "@tauri-apps/api/core";
import { native } from "./native";
import { output } from "./output.svelte";
import { isAndroid } from "./platform";

/** Number of frequency bands, low to high (40 Hz – 16 kHz, log scale). */
export const BANDS = 48;

/**
 * Live sound levels for the visualizer.
 *
 * Windows: the player's <audio> element is routed through a Web Audio
 * analyser. That only happens the first time the visualizer opens, and then
 * stays for the session (an element can't be unhooked again). The chosen
 * output device follows (AudioContext.setSinkId).
 *
 * Android: playback is native, so the player service measures the sound and
 * sends ~30 "spectrum" events a second while the visualizer is open.
 */
class Spectrum {
  /** Smoothed levels 0–1, updated by `update()` once per frame. */
  levels = new Float32Array(BANDS);
  /** Overall loudness and the low / mid / high parts, 0–1. */
  energy = 0;
  bass = 0;
  mid = 0;
  treble = 0;
  /** A kick in the bass this frame (0 or a strength up to 1). */
  beat = 0;
  /** Why levels aren't available, if they aren't. */
  unavailable = "";

  private raw = new Float32Array(BANDS);
  private els: HTMLMediaElement[] = [];
  private ctx?: AudioContext;
  private gain?: GainNode;
  private muted = false;
  private analyser?: AnalyserNode;
  private bins?: Uint8Array<ArrayBuffer>;
  private users = 0;
  private listener?: PluginListener;
  private lastNative = 0;
  private bassAvg = 0;
  private sinceBeat = 0;

  /** The desktop player's audio elements (LocalEngine registers its two decks). */
  register(el: HTMLMediaElement) {
    if (!this.els.includes(el)) this.els.push(el);
  }

  /** True once the element feeds the analyser (it must then stay CORS-clean). */
  get hooked() {
    return !!this.ctx;
  }

  /** Silences the speakers but keeps the levels (Discord-only playback). */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
  }

  /** The element couldn't load with CORS: the desktop visualizer can't hear it. */
  corsBroken() {
    this.unavailable = "The visualizer can't read this audio on this PC.";
  }

  async start() {
    if (this.users++ > 0) return;
    if (isAndroid) {
      this.listener = await native.on<{ b: number[] }>("spectrum", (e) => {
        const b = e.b ?? [];
        for (let i = 0; i < BANDS; i++) this.raw[i] = (b[i] ?? 0) / 255;
        this.lastNative = performance.now();
      });
      await native.call("vizStart").catch(() => {});
      return;
    }
    if (!this.els.length || this.unavailable) return;
    if (!this.ctx) {
      try {
        const ctx = new AudioContext({ latencyHint: "playback" });
        const an = ctx.createAnalyser();
        an.fftSize = 4096;
        an.smoothingTimeConstant = 0.55;
        an.minDecibels = -88;
        an.maxDecibels = -22;
        const gain = ctx.createGain();
        // The elements may have been muted for Discord: mute after the analyser instead.
        this.muted = this.muted || this.els.some((e) => e.muted);
        for (const el of this.els) {
          el.muted = false;
          ctx.createMediaElementSource(el).connect(an);
        }
        gain.gain.value = this.muted ? 0 : 1;
        an.connect(gain);
        gain.connect(ctx.destination);
        this.gain = gain;
        this.ctx = ctx;
        this.analyser = an;
        this.bins = new Uint8Array(an.frequencyBinCount);
        output.attach(ctx);
      } catch {
        this.unavailable = "The visualizer couldn't start on this PC.";
        return;
      }
    }
    await this.ctx.resume().catch(() => {});
  }

  stop() {
    if (this.users === 0 || --this.users > 0) return;
    if (isAndroid) {
      native.call("vizStop").catch(() => {});
      this.listener?.unregister().catch(() => {});
      this.listener = undefined;
    }
    // Desktop: the audio keeps flowing through the (now idle) analyser.
  }

  /** Reads the newest levels; call once per animation frame. */
  update() {
    if (this.analyser && this.bins && this.ctx) {
      this.analyser.getByteFrequencyData(this.bins);
      const binHz = this.ctx.sampleRate / this.analyser.fftSize;
      const hi = Math.min(16000, this.ctx.sampleRate / 2 - binHz);
      for (let b = 0; b < BANDS; b++) {
        const f0 = 40 * Math.pow(hi / 40, b / BANDS);
        const f1 = 40 * Math.pow(hi / 40, (b + 1) / BANDS);
        const i0 = Math.max(1, Math.floor(f0 / binHz));
        const i1 = Math.max(i0, Math.min(this.bins.length - 1, Math.floor(f1 / binHz)));
        let peak = 0;
        for (let i = i0; i <= i1; i++) peak = Math.max(peak, this.bins[i]);
        this.raw[b] = peak / 255;
      }
    } else if (isAndroid && performance.now() - this.lastNative > 400) {
      this.raw.fill(0);
    }

    // Fast attack, slow release: lively without flicker.
    let sum = 0;
    for (let i = 0; i < BANDS; i++) {
      const r = this.raw[i];
      const l = this.levels[i];
      this.levels[i] = r > l ? l + (r - l) * 0.6 : l + (r - l) * 0.12;
      sum += this.levels[i];
    }
    const avg = (from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += this.levels[i];
      return s / (to - from);
    };
    this.energy = sum / BANDS;
    this.bass = avg(0, 8);
    this.mid = avg(8, 28);
    this.treble = avg(28, BANDS);

    // A beat: the bass jumps well above its recent average.
    this.bassAvg = this.bassAvg * 0.94 + this.bass * 0.06;
    this.sinceBeat++;
    if (this.bass > 0.25 && this.bass > this.bassAvg * 1.25 && this.sinceBeat > 12) {
      this.beat = Math.min(1, (this.bass - this.bassAvg) * 3);
      this.sinceBeat = 0;
    } else {
      this.beat *= 0.85;
    }
  }
}

export const spectrum = new Spectrum();
