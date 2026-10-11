/** Same rules as catalog.rs, so Last.fm, the catalog and your files agree on "the same song". */
export function norm(s: string): string {
  let out = "";
  for (const c of s.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(c)) out += c;
    else if (!out.endsWith(" ")) out += " ";
  }
  return out.trim();
}

/** "Let It Be - 2009 Remaster" → "let it be"; "Get Lucky (feat. X)" → "get lucky" */
export function coreTitle(s: string): string {
  const lower = s.toLowerCase();
  const cuts = ["remaster", "feat.", "feat ", "ft.", "(with ", " - "]
    .map((w) => lower.indexOf(w))
    .filter((i) => i >= 0);
  const end = cuts.length ? Math.min(...cuts) : lower.length;
  return norm(lower.slice(0, end).replace(/[\s([-]+$/, ""));
}

/** Main artist only: "Daft Punk feat. Pharrell" / "A & B" / "A, B" → "daft punk" / "a" */
export function mainArtist(s: string): string {
  return norm(s.split(/\s+(?:feat\.?|ft\.?|featuring|&|x|and)\s+|,/i)[0] ?? s);
}

export const songKey = (artist: string, title: string) => `${mainArtist(artist)}|${coreTitle(title)}`;
export const albumKey = (artist: string, album: string) => `${mainArtist(artist)}|${coreTitle(album)}`;
