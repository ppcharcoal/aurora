/**
 * The maths of a transition (no app state, no browser APIs): volume and
 * effect lines over time. Shared by the desktop player, the transition
 * editor and the Discord bot (discord/src), so all three play a transition
 * exactly the same way.
 */

export interface Fx {
  /** 0 = clear, 1 = fully muffled (like through a wall). */
  damp: number;
  /** −1…1 → −12…+12 dB around 110 Hz. */
  bass: number;
  /** −1…1 → −12…+12 dB around 6 kHz. */
  treble: number;
}

export const NEUTRAL: Fx = { damp: 0, bass: 0, treble: 0 };
export const isNeutral = (f: Fx) => f.damp < 0.002 && Math.abs(f.bass) < 0.002 && Math.abs(f.treble) < 0.002;

/** Low-pass cutoff for a dampen amount (exponential, 20 kHz → 250 Hz). */
export const dampHz = (d: number) => 20000 * Math.pow(250 / 20000, Math.min(1, Math.max(0, d)));

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
  /**
   * Volume points drawn in the editor (custom transitions). When present they
   * replace the fade/gain numbers above. A's are on A's timeline; B's are ms
   * after B starts (so they move with B). Between points the volume follows
   * `curve`; after B's last point it returns to 100% over 1.5 s.
   */
  aPoints?: Point[];
  bPoints?: Point[];
  /** Effects drawn in the editor, same timing rules as the volume points. */
  aFx?: FxLanes;
  bFx?: FxLanes;
}

/**
 * Effect lines. Values 0–1: dampen 0 = clear … 1 = fully muffled; bass and
 * treble 0.5 = unchanged, 0 = −12 dB, 1 = +12 dB. No line = no effect.
 */
export type FxName = "damp" | "bass" | "treble";
export type FxLanes = Partial<Record<FxName, Point[]>>;
export const FX_NAMES: FxName[] = ["damp", "bass", "treble"];
/** The "no effect" value of each line. */
export const FX_REST: Record<FxName, number> = { damp: 0, bass: 0.5, treble: 0.5 };

/** One volume point: time (ms) and volume (0–1). */
export interface Point {
  t: number;
  g: number;
}

/** 0→1 shape of a fade. "smooth" keeps the loudness even across a crossfade (equal power). */
export function shape(x: number, curve: Curve) {
  const v = Math.min(1, Math.max(0, x));
  return curve === "smooth" ? Math.sin((v * Math.PI) / 2) : v;
}

export const SETTLE_MS = 1500;

/** Volume between two points; "smooth" uses equal-power curves (no dip in loudness mid-crossfade). */
function between(p: Point, q: Point, t: number, curve: Curve) {
  const x = q.t > p.t ? Math.min(1, Math.max(0, (t - p.t) / (q.t - p.t))) : 1;
  if (curve === "linear") return p.g + (q.g - p.g) * x;
  return q.g < p.g ? q.g + (p.g - q.g) * Math.cos((x * Math.PI) / 2) : p.g + (q.g - p.g) * Math.sin((x * Math.PI) / 2);
}

/** Volume along a list of points (held flat before the first and after the last). */
export function along(pts: Point[], t: number, curve: Curve) {
  if (!pts.length) return 1;
  if (t <= pts[0].t) return pts[0].g;
  for (let i = 1; i < pts.length; i++) if (t <= pts[i].t) return between(pts[i - 1], pts[i], t, curve);
  return pts[pts.length - 1].g;
}

/** Volume of A at A-time `t`. */
export function gainA(m: Mix, t: number) {
  if (t >= m.aEnd) return 0;
  if (m.aPoints?.length) return Math.min(1, Math.max(0, along(m.aPoints, t, m.curve)));
  let g = t < m.bStart ? 1 : 1 + (m.aGain - 1) * Math.min(1, (t - m.bStart) / 400);
  if (m.fadeOut > 0 && t > m.aEnd - m.fadeOut) g *= shape((m.aEnd - t) / m.fadeOut, m.curve);
  return g;
}

/** Volume of B at A-time `t` (B's own time is t − bStart + bOffset). */
export function gainB(m: Mix, t: number) {
  if (t < m.bStart) return 0;
  if (m.bPoints?.length) {
    const r = t - m.bStart;
    const last = m.bPoints[m.bPoints.length - 1];
    const g = r <= last.t ? along(m.bPoints, r, m.curve) : last.g + (1 - last.g) * Math.min(1, (r - last.t) / SETTLE_MS);
    return Math.min(1, Math.max(0, g));
  }
  const inG = m.fadeIn > 0 ? shape((t - m.bStart) / m.fadeIn, m.curve) : 1;
  const end = Math.max(m.aEnd, m.bStart + m.fadeIn);
  const level = t <= end ? m.bGain : m.bGain + (1 - m.bGain) * Math.min(1, (t - end) / SETTLE_MS);
  return inG * level;
}

const toFx = (name: FxName, v: number) => (name === "damp" ? v : (v - 0.5) * 2);

/** Effects on A at A-time `t`. */
export function fxA(m: Mix, t: number): Fx {
  const out: Fx = { ...NEUTRAL };
  for (const n of FX_NAMES) {
    const pts = m.aFx?.[n];
    if (pts?.length) out[n] = toFx(n, along(pts, t, m.curve));
  }
  return out;
}

/** Effects on B at A-time `t`; after a line's last point it eases back to "no effect". */
export function fxB(m: Mix, t: number): Fx {
  const out: Fx = { ...NEUTRAL };
  const r = t - m.bStart;
  for (const n of FX_NAMES) {
    const pts = m.bFx?.[n];
    if (!pts?.length) continue;
    const last = pts[pts.length - 1];
    const v = r <= last.t ? along(pts, r, m.curve) : last.g + (FX_REST[n] - last.g) * Math.min(1, (r - last.t) / SETTLE_MS);
    out[n] = toFx(n, v);
  }
  return out;
}

/** Any effect lines at all? */
export const hasFx = (f?: FxLanes) => !!f && FX_NAMES.some((n) => f[n]?.length);

/** When the transition is completely over, on A's timeline. */
export function mixEnd(m: Mix) {
  let fxEnd = 0;
  for (const n of FX_NAMES) {
    const last = m.bFx?.[n]?.at(-1);
    if (last) fxEnd = Math.max(fxEnd, m.bStart + last.t + (Math.abs(last.g - FX_REST[n]) > 0.001 ? SETTLE_MS : 0));
  }
  return Math.max(fxEnd, mixEndVolume(m));
}

function mixEndVolume(m: Mix) {
  if (m.bPoints?.length) {
    const last = m.bPoints[m.bPoints.length - 1];
    return Math.max(m.aEnd, m.bStart + last.t + (last.g < 1 ? SETTLE_MS : 0));
  }
  return Math.max(m.aEnd, m.bStart + m.fadeIn) + (m.bGain < 1 ? SETTLE_MS : 0);
}

/** The same mix with its fades written out as volume points (for editing). */
export function withPoints(m: Mix): Mix {
  if (m.aPoints && m.bPoints) return m;
  const fs = m.aEnd - m.fadeOut;
  const a: Point[] = [{ t: Math.min(m.bStart, fs), g: 1 }];
  if (fs > a[0].t + 1) a.push({ t: fs, g: m.aGain });
  else a[0].g = m.aGain;
  if (m.aEnd > fs + 1) a.push({ t: m.aEnd, g: 0 });
  const b: Point[] = [{ t: 0, g: m.fadeIn > 0 ? 0 : m.bGain }];
  if (m.fadeIn > 0) b.push({ t: m.fadeIn, g: m.bGain });
  return { ...m, aPoints: m.aPoints ?? a, bPoints: m.bPoints ?? b };
}

function cleanFx(f: FxLanes, min: number, max: number): FxLanes {
  const out: FxLanes = {};
  for (const n of FX_NAMES) if (f[n]?.length) out[n] = cleanPoints(f[n], min, max);
  return out;
}

const cleanPoints = (pts: Point[] | undefined, min: number, max: number) =>
  pts
    ?.map((p) => ({ t: Math.min(max, Math.max(min, Math.round(p.t))), g: Math.round(Math.min(1, Math.max(0, p.g)) * 1000) / 1000 }))
    .sort((p, q) => p.t - q.t)
    .slice(0, 64);

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
    ...(m.aPoints ? { aPoints: cleanPoints(m.aPoints, 0, aEnd) } : {}),
    ...(m.bPoints ? { bPoints: cleanPoints(m.bPoints, 0, Math.max(0, (bDur || 600000) - bOffset)) } : {}),
    ...(hasFx(m.aFx) ? { aFx: cleanFx(m.aFx!, 0, aEnd) } : {}),
    ...(hasFx(m.bFx) ? { bFx: cleanFx(m.bFx!, 0, Math.max(0, (bDur || 600000) - bOffset)) } : {}),
  };
}

