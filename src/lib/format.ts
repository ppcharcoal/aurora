export function time(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function totalTime(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} hr ${min % 60} min`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** MP3 bitrate (kbit/s) used for size estimates; "best" (VBR V0) averages about 210 on YouTube sources. */
const KBPS: Record<string, number> = { original: 135, best: 210, "320": 320, "192": 192, "128": 128, small: 50 };

/** Estimated file size in bytes for a duration at a quality setting (+ embedded cover). */
export function estimateBytes(durationMs: number, quality: string): number {
  if (!durationMs) return 0;
  return (durationMs / 1000) * ((KBPS[quality] ?? 210) * 1000) / 8 + 120_000;
}

export function bytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** "≈ 7.4 MB" */
export const approx = (durationMs: number, quality: string) =>
  durationMs ? `≈ ${bytes(estimateBytes(durationMs, quality))}` : "";
