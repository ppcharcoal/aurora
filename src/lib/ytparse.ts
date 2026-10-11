/** Turns "Artist - Title (Official Video)" + channel into a tidy title/artist. */
export function splitTitle(raw: string, channel?: string | null): { title: string; artist: string } {
  const clean = raw
    .replace(
      /\s*[([](official\s*(music\s*)?(video|audio|lyric video|visuali[sz]er)|lyrics?|audio|hd|4k|mv)[)\]]/gi,
      "",
    )
    .trim();
  const m = clean.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  const ch = (channel ?? "").replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();
  return { title: clean, artist: ch || "YouTube" };
}

export const thumb = (id: string, large = false) =>
  `https://i.ytimg.com/vi/${id}/${large ? "hqdefault" : "mqdefault"}.jpg`;

export function views(n?: number | null): string {
  if (!n) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K views`;
  return `${n} views`;
}

/**
 * For <img onerror> and onload. maxresdefault doesn't exist for every video,
 * and YouTube answers with a grey 120×90 placeholder instead of failing, so
 * check the size too and step down to a smaller frame.
 */
export function thumbFallback(e: Event) {
  const img = e.currentTarget as HTMLImageElement;
  if (e.type === "load" && img.naturalWidth > 120) return;
  if (img.src.includes("maxresdefault")) img.src = img.src.replace("maxresdefault", "hqdefault");
  else if (img.src.includes("hqdefault")) img.src = img.src.replace("hqdefault", "mqdefault");
}
