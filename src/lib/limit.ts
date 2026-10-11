import { estimateBytes } from "./format";

/** A typical song (3.5 minutes), for "how many songs fit" estimates. */
export const AVG_SONG_MS = 210_000;

const GB = 1e9;
/** Slider stops for the data limit, in bytes. The slider's last stop is "No limit" (0). */
export const LIMIT_STEPS = [0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000].map((g) => g * GB);

/** About how many songs fit in `bytes` at a quality setting. */
export function songsFit(bytes: number, quality: string): number {
  return Math.floor(bytes / estimateBytes(AVG_SONG_MS, quality));
}

/** Slider position for a limit (0 = no limit → last stop). */
export function stepOf(limit: number): number {
  if (!limit) return LIMIT_STEPS.length;
  let best = 0;
  for (let i = 0; i < LIMIT_STEPS.length; i++) if (Math.abs(LIMIT_STEPS[i] - limit) < Math.abs(LIMIT_STEPS[best] - limit)) best = i;
  return best;
}

export const limitAt = (step: number) => LIMIT_STEPS[step] ?? 0;

/** "≈ 4,100" */
export const count = (n: number) => (n >= 1000 ? `≈ ${(Math.round(n / 100) * 100).toLocaleString()}` : `≈ ${n.toLocaleString()}`);
