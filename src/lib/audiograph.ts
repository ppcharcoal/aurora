import { output } from "./output.svelte";

/**
 * Desktop sound path through Web Audio, shared by the player, the visualizer
 * and the transition editor's preview:
 *
 *   <audio> → dampen (low-pass) → bass (low shelf) → treble (high shelf) → volume ┐
 *   <audio> → …                                                                    ├→ analyser → mute → speakers
 *
 * An element is only routed here when it's needed (an effect, or the
 * visualizer), and then stays routed (browsers can't undo that). All of this
 * is live processing: the music files are never touched.
 */

export { NEUTRAL, isNeutral, dampHz, type Fx } from "./mixmath";
import { dampHz, isNeutral, type Fx } from "./mixmath";

const DB = 12;

interface Chain {
  src: MediaElementAudioSourceNode;
  lp: BiquadFilterNode;
  low: BiquadFilterNode;
  high: BiquadFilterNode;
  gain: GainNode;
}

class AudioGraph {
  ctx?: AudioContext;
  analyser?: AnalyserNode;
  private mute?: GainNode;
  private muted = false;
  private chains = new Map<HTMLMediaElement, Chain>();
  /** Set when an element can't be routed (a CORS problem): effects are then skipped. */
  broken = false;

  private ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: "playback" });
    const an = ctx.createAnalyser();
    an.fftSize = 4096;
    an.smoothingTimeConstant = 0.55;
    an.minDecibels = -88;
    an.maxDecibels = -22;
    const mute = ctx.createGain();
    mute.gain.value = this.muted ? 0 : 1;
    an.connect(mute);
    mute.connect(ctx.destination);
    this.ctx = ctx;
    this.analyser = an;
    this.mute = mute;
    output.attach(ctx);
    return ctx;
  }

  has(el: HTMLMediaElement) {
    return this.chains.has(el);
  }

  /** Routes an element through the effects (once). Returns null if it can't be. */
  route(el: HTMLMediaElement): Chain | null {
    const have = this.chains.get(el);
    if (have) return have;
    if (this.broken || !el.crossOrigin) return null;
    try {
      const ctx = this.ensure();
      const src = ctx.createMediaElementSource(el);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 20000;
      lp.Q.value = 0.7;
      const low = ctx.createBiquadFilter();
      low.type = "lowshelf";
      low.frequency.value = 110;
      const high = ctx.createBiquadFilter();
      high.type = "highshelf";
      high.frequency.value = 6000;
      const gain = ctx.createGain();
      // The element's own volume moves here (and the element stays at full volume).
      gain.gain.value = el.volume; // muting (Discord) happens after the analyser
      el.volume = 1;
      el.muted = false;
      src.connect(lp).connect(low).connect(high).connect(gain).connect(this.analyser!);
      const chain = { src, lp, low, high, gain };
      this.chains.set(el, chain);
      ctx.resume().catch(() => {});
      return chain;
    } catch {
      this.broken = true;
      return null;
    }
  }

  /** Disconnects an element that won't be used again (editor previews). */
  release(el: HTMLMediaElement) {
    const c = this.chains.get(el);
    if (!c) return;
    c.gain.disconnect();
    this.chains.delete(el);
  }

  setVolume(el: HTMLMediaElement, v: number) {
    const c = this.chains.get(el);
    const val = Math.min(1, Math.max(0, v));
    if (!c) {
      el.volume = val;
      return;
    }
    c.gain.gain.setTargetAtTime(val, this.ctx!.currentTime, 0.012);
  }

  volumeOf(el: HTMLMediaElement) {
    const c = this.chains.get(el);
    return c ? c.gain.gain.value : el.volume;
  }

  /** Sets the effects on an element (routing it first if an effect is on). */
  setFx(el: HTMLMediaElement, fx: Fx) {
    let c = this.chains.get(el);
    if (!c) {
      if (isNeutral(fx)) return;
      c = this.route(el) ?? undefined;
      if (!c) return;
    }
    const now = this.ctx!.currentTime;
    c.lp.frequency.setTargetAtTime(dampHz(fx.damp), now, 0.03);
    c.low.gain.setTargetAtTime(Math.max(-1, Math.min(1, fx.bass)) * DB, now, 0.03);
    c.high.gain.setTargetAtTime(Math.max(-1, Math.min(1, fx.treble)) * DB, now, 0.03);
  }

  /** Discord-only playback: silence the speakers but keep the visualizer's levels. */
  setMuted(muted: boolean, els: HTMLMediaElement[]) {
    this.muted = muted;
    if (this.mute) this.mute.gain.value = muted ? 0 : 1;
    for (const el of els) if (!this.chains.has(el)) el.muted = muted;
  }

  /** Visualizer: route the player's elements and wake the context. */
  async listen(els: HTMLMediaElement[]) {
    for (const el of els) if (!this.route(el)) return false;
    await this.ctx?.resume().catch(() => {});
    return !!this.analyser;
  }
}

export const graph = new AudioGraph();
