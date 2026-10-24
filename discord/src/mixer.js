// The bot's player: decodes songs with FFmpeg, mixes them here (volume,
// transitions with their volume and effect lines, exactly like the app),
// and encodes the result to Opus for Discord with a second FFmpeg.
//
//   song A ─ffmpeg→ PCM ┐
//                       ├→ gains + dampen/bass/treble → PCM ─ffmpeg→ Ogg/Opus → Discord
//   song B ─ffmpeg→ PCM ┘   (only during a transition)
//
// The music files are only read, never changed.

"use strict";

const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { fxA, fxB, gainA, gainB, hasFx, mixEnd, dampHz } = require("../../src/lib/mixmath.ts");

const RATE = 48000;
const FRAMES = 960; // 20 ms
const BLOCK = FRAMES * 4; // s16le stereo
const PRELOAD_MS = 4000;

/** Reads exactly n bytes at a time from a stream (fewer at the end). */
class Reader {
  constructor(stream) {
    this.stream = stream;
    this.chunks = [];
    this.size = 0;
    this.ended = false;
    this.waiters = [];
    stream.on("data", (c) => {
      this.chunks.push(c);
      this.size += c.length;
      if (this.size > BLOCK * 16) stream.pause();
      this.wake();
    });
    stream.on("end", () => {
      this.ended = true;
      this.wake();
    });
    stream.on("error", () => {
      this.ended = true;
      this.wake();
    });
  }
  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  async read(n) {
    while (this.size < n && !this.ended) {
      this.stream.resume();
      await new Promise((r) => this.waiters.push(r));
    }
    if (!this.size) return null;
    const all = Buffer.concat(this.chunks);
    const take = all.subarray(0, Math.min(n, all.length));
    const rest = all.subarray(take.length);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    if (this.size < BLOCK * 6) this.stream.resume();
    return take;
  }
}

/** One playing song: an FFmpeg decoder from a position. */
class Deck {
  constructor(ffmpeg, track, fromMs, onError) {
    this.track = track;
    this.startMs = Math.max(0, fromMs);
    this.frames = 0;
    this.proc = spawn(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", (this.startMs / 1000).toFixed(3), "-i", track.path, "-vn", "-ac", "2", "-ar", String(RATE), "-f", "s16le", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let err = "";
    this.proc.stderr.on("data", (d) => (err = (err + d).slice(-400)));
    this.proc.on("error", (e) => onError(`FFmpeg couldn't start (${e.message}).`));
    this.proc.on("close", (code) => {
      if (code && !this.killed) onError(`FFmpeg stopped: ${err.trim() || "code " + code}`);
    });
    this.reader = new Reader(this.proc.stdout);
    this.filters = new Filters();
  }
  /** Position in the song, ms. */
  get ms() {
    return this.startMs + (this.frames * 1000) / RATE;
  }
  async block() {
    const b = await this.reader.read(BLOCK);
    if (!b) return null;
    this.frames += b.length / 4;
    return b;
  }
  kill() {
    this.killed = true;
    try {
      this.proc.kill("SIGKILL");
    } catch {}
  }
}

/* ------------------------------------------------- effects (biquads) -- */

class Biquad {
  constructor() {
    this.set(1, 0, 0, 0, 0);
    this.z = [0, 0, 0, 0, 0, 0, 0, 0]; // x1 x2 y1 y2 per channel
  }
  set(b0, b1, b2, a1, a2) {
    this.c = [b0, b1, b2, a1, a2];
  }
  lowpass(f) {
    const w = (2 * Math.PI * Math.min(f, RATE * 0.45)) / RATE;
    const al = Math.sin(w) / (2 * 0.7071);
    const cs = Math.cos(w);
    const a0 = 1 + al;
    this.set((1 - cs) / 2 / a0, (1 - cs) / a0, (1 - cs) / 2 / a0, (-2 * cs) / a0, (1 - al) / a0);
  }
  shelf(f, db, high) {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * f) / RATE;
    const cs = Math.cos(w);
    const al = (Math.sin(w) / 2) * Math.SQRT2;
    const sq = 2 * Math.sqrt(A) * al;
    let b0, b1, b2, a0, a1, a2;
    if (!high) {
      b0 = A * (A + 1 - (A - 1) * cs + sq);
      b1 = 2 * A * (A - 1 - (A + 1) * cs);
      b2 = A * (A + 1 - (A - 1) * cs - sq);
      a0 = A + 1 + (A - 1) * cs + sq;
      a1 = -2 * (A - 1 + (A + 1) * cs);
      a2 = A + 1 + (A - 1) * cs - sq;
    } else {
      b0 = A * (A + 1 + (A - 1) * cs + sq);
      b1 = -2 * A * (A - 1 + (A + 1) * cs);
      b2 = A * (A + 1 + (A - 1) * cs - sq);
      a0 = A + 1 - (A - 1) * cs + sq;
      a1 = 2 * (A - 1 - (A + 1) * cs);
      a2 = A + 1 - (A - 1) * cs - sq;
    }
    this.set(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }
  run(x, ch) {
    const [b0, b1, b2, a1, a2] = this.c;
    const z = this.z;
    const o = ch * 4;
    const y = b0 * x + b1 * z[o] + b2 * z[o + 1] - a1 * z[o + 2] - a2 * z[o + 3];
    z[o + 1] = z[o];
    z[o] = x;
    z[o + 3] = z[o + 2];
    z[o + 2] = y;
    return y;
  }
}

class Filters {
  constructor() {
    this.lp = new Biquad();
    this.lo = new Biquad();
    this.hi = new Biquad();
    this.on = false;
  }
  set(fx) {
    this.on = fx.damp > 0.002 || Math.abs(fx.bass) > 0.002 || Math.abs(fx.treble) > 0.002;
    if (!this.on) return;
    this.lp.lowpass(dampHz(fx.damp));
    this.lo.shelf(110, fx.bass * 12, false);
    this.hi.shelf(6000, fx.treble * 12, true);
  }
  run(x, ch) {
    return this.on ? this.hi.run(this.lo.run(this.lp.run(x, ch), ch), ch) : x;
  }
}

/* --------------------------------------------------------- session -- */

const perceptual = (v) => Math.min(1, Math.max(0, v * v));

/**
 * Plays `track` from `fromMs` and, if `next` is set ({ track, mix }), goes
 * into the next song exactly as the transition says (with a gapless "None"
 * when there's no mix). Emits PCM on `out`. Call `stop()` to end it.
 */
class Session {
  constructor({ ffmpeg, track, fromMs, next, volume, onSwitch, onError }) {
    this.ffmpeg = ffmpeg;
    this.onSwitch = onSwitch ?? (() => {});
    this.onError = onError ?? (() => {});
    this.volume = volume ?? 1;
    this.cur = new Deck(ffmpeg, track, fromMs, this.onError);
    this.next = next ?? null;
    this.inc = null; // the next song's deck once it's loaded
    this.out = null; // during a transition: the song fading out
    this.mix = null; // the running transition
    this.gains = [perceptual(this.volume), 0];
    this.stopped = false;
    /** Output time (ms of mixed audio written) where each song starts: to tell what's heard. */
    this.writtenMs = 0;
    this.marks = [{ outMs: 0, track, ms: Math.max(0, fromMs) }];
    /** A plan for the song after the next one, received before the transition began. */
    this.after = null;
    this.pcm = new PassThrough({ highWaterMark: BLOCK * 8 });
    this.encoder = spawn(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(RATE), "-ac", "2", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "128k", "-frame_duration", "20", "-application", "audio", "-f", "ogg", "pipe:1"],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    this.encoder.on("error", (e) => this.onError(`FFmpeg couldn't start (${e.message}). Install FFmpeg, or let Aurora install its tools.`));
    this.encoder.stdin.on("error", () => {});
    this.pcm.pipe(this.encoder.stdin);
    /** Ogg/Opus for Discord. */
    this.ogg = this.encoder.stdout;
    this.loop();
  }

  /** The current song and where in it (ms), as decoded (a little ahead of what's heard). */
  get position() {
    return { track: this.cur.track, ms: this.cur.ms };
  }

  /** What's heard after `playedMs` of this session's audio has played in Discord. */
  heard(playedMs) {
    let m = this.marks[0];
    for (const k of this.marks) if (k.outMs <= playedMs) m = k;
    return { track: m.track, ms: m.ms + (playedMs - m.outMs) };
  }

  setVolume(v) {
    this.volume = v;
  }

  /**
   * What comes next and how (null: the music stops after this song). `from`
   * is the song the plan starts from: if that's the one we're about to go
   * into, the plan is kept for after the transition.
   */
  setNext(next, from) {
    if (from && from !== this.cur.track.path && this.next?.track.path === from) {
      this.after = next ?? null;
      return;
    }
    if (this.inc && (!next || next.track.path !== this.inc.track.path)) {
      this.inc.kill();
      this.inc = null;
    }
    this.next = next ?? null;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const d of [this.cur, this.inc, this.out]) d?.kill();
    this.pcm.end();
    setTimeout(() => {
      try {
        this.encoder.kill("SIGKILL");
      } catch {}
    }, 400);
  }

  async loop() {
    while (!this.stopped) {
      const n = this.next;
      // Get the next song ready a few seconds before it comes in.
      if (n && !this.inc && !this.mix && this.cur.ms >= n.mix.bStart - PRELOAD_MS) {
        this.inc = new Deck(this.ffmpeg, n.track, n.mix.bOffset, this.onError);
      }
      if (n && !this.mix && this.cur.ms >= n.mix.bStart) this.begin(this.cur.ms);
      let blk = await this.cur.block();
      if (this.stopped) break;
      if (!blk) {
        // The song ended before its transition point (or "None"): go straight on, gapless.
        if (!this.mix && this.next) {
          this.begin(this.cur.ms);
          continue;
        }
        if (this.mix && this.out) blk = Buffer.alloc(BLOCK);
        else break;
      }
      const r = this.mix ? await this.mixBlock(blk) : this.soloBlock(blk);
      if (!r) break;
      this.writtenMs += (r.length / 4 / RATE) * 1000;
      if (!this.pcm.write(r)) await new Promise((res) => this.pcm.once("drain", res));
    }
    if (!this.stopped) this.stop();
  }

  /** The transition starts: the next song becomes the current one, the old one fades out. */
  begin(aT) {
    const n = this.next;
    const late = Math.max(0, aT - n.mix.bStart);
    // Ready deck started at the transition point; if we're already past it (a seek), start where we are.
    if (this.inc && late > 100) {
      this.inc.kill();
      this.inc = null;
    }
    if (!this.inc) this.inc = new Deck(this.ffmpeg, n.track, n.mix.bOffset + late, this.onError);
    this.out = this.cur;
    this.cur = this.inc;
    this.inc = null;
    this.mix = n.mix;
    this.next = this.after;
    this.after = null;
    this.marks.push({ outMs: this.writtenMs, track: this.cur.track, ms: this.cur.ms });
    if (this.marks.length > 8) this.marks.splice(1, this.marks.length - 8);
    this.onSwitch(this.cur.track);
  }

  soloBlock(buf) {
    const g = perceptual(this.volume);
    this.ramp(buf, null, this.gains[0], g, null, this.cur.filters);
    this.gains[0] = g;
    return buf;
  }

  async mixBlock(bBuf) {
    // `bBuf` is the current (incoming) song; read the outgoing one alongside.
    const m = this.mix;
    const outDeck = this.out;
    let aBuf = null;
    if (outDeck) {
      aBuf = outDeck.ms < m.aEnd ? await outDeck.block() : null;
      if (!aBuf) {
        outDeck.kill();
        this.out = null;
      }
    }
    const v = perceptual(this.volume);
    const aT = outDeck ? outDeck.ms : 0;
    const t = m.bStart + (this.cur.ms - m.bOffset); // A's timeline, from B's clock
    const gA = aBuf ? v * gainA(m, aT) : 0;
    const gB = v * gainB(m, t);
    if (hasFx(m.aFx) && aBuf) outDeck.filters.set(fxA(m, aT));
    if (hasFx(m.bFx)) this.cur.filters.set(fxB(m, t));
    const len = Math.max(bBuf?.length ?? 0, aBuf?.length ?? 0);
    if (!len) return null;
    const res = Buffer.alloc(BLOCK);
    if (bBuf) bBuf.copy(res);
    this.ramp(res, aBuf, this.gains[1], gB, outDeck?.filters, this.cur.filters, this.gains[0], gA);
    this.gains = [gA, gB];
    if (!this.out && t >= mixEnd(m)) {
      // Transition over: the new song carries on alone, back to plain volume.
      this.mix = null;
      this.cur.filters.set({ damp: 0, bass: 0, treble: 0 });
      this.gains = [gB, 0];
    }
    return res;
  }

  /**
   * In place: buf = buf·gain (+ other·otherGain), each gain moving smoothly
   * from its old to its new value across the block, effects applied per song.
   */
  ramp(buf, other, g0, g1, otherFilters, filters, og0 = 0, og1 = 0) {
    const n = buf.length / 2;
    const frames = n / 2;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(i / 2) / frames;
      const ch = i & 1;
      let x = filters ? filters.run(buf.readInt16LE(i * 2), ch) : buf.readInt16LE(i * 2);
      x *= g0 + (g1 - g0) * k;
      if (other && i * 2 < other.length) {
        let y = other.readInt16LE(i * 2);
        if (otherFilters) y = otherFilters.run(y, ch);
        x += y * (og0 + (og1 - og0) * k);
      }
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x))), i * 2);
    }
  }
}

module.exports = { Session, RATE };
